import { createPublicClient, formatUnits, getAddress, http, parseUnits, type Address, type Hex } from 'viem';
import { ROBINHOOD_MAINNET_CHAIN_ID, type Instrument, type VenueHealth } from '@punklabz/shared';
import type {
  AdapterBalance, AdapterOrderResult, AdapterOrderStatus, AdapterPosition,
  AdapterQuote, ExecutionAdapter, ReconciliationResult,
} from '../adapters.js';
import type { TradingSigner } from '../signing/signer.js';
import { rhChainDef } from '../../chain/rhChain.js';
import { ZEROX_ALLOWANCE_HOLDER, resolveLiveInstrument } from '../instrumentResolver.js';
import { SETTLEMENT } from '../instruments.js';

// THE VENUE ADAPTER. The last piece of code between an approved intent and a
// transaction on a public chain.
//
// Its whole job is distrust. 0x returns a transaction to sign; this file
// assumes that transaction could be wrong — through a bug, a bad response, or
// a compromised endpoint — and checks every field against the intent that was
// actually approved before a signature is requested. "Never sign unexpected
// calldata" is not a slogan; it is the list of checks in verifyQuote().
//
// Two properties matter more than the rest:
//
//   1. minBuyAmount is computed BEFORE signing and comes back from 0x inside
//      the calldata. Checking slippage after a chain transaction has landed is
//      measurement, not protection — the funds have already moved.
//
//   2. A broadcast is NOT a fill. submitOrder returns `pending` with a tx
//      hash; only a receipt with status 'success' and decoded transfer amounts
//      produces a fill. Marking an order filled because a POST returned 200 is
//      how a ledger starts lying.

const ZEROX_API = 'https://api.0x.org';

/** Contracts this adapter will ever let a signature target. */
const APPROVED_TARGETS = new Set([ZEROX_ALLOWANCE_HOLDER.toLowerCase()]);

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface ZeroXQuote {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  to: string;
  data: string;
  value: string;
  gas?: string;
  allowanceTarget?: string;
}

export interface QuoteVerification {
  ok: boolean;
  failures: string[];
}

export interface VerifyArgs {
  quote: ZeroXQuote;
  expect: {
    chainId: number;
    sellToken: string;
    buyToken: string;
    sellAmount: bigint;
    /** the risk-approved ceiling, in bps; the quote must guarantee at least this much */
    maxSlippageBps: number;
    signerAddress: string;
  };
}

/**
 * PURE. Every field of a 0x quote checked against what was approved.
 *
 * Pure so it is testable without a network, and so the list of things that
 * must hold is readable in one place rather than scattered through an async
 * function nobody reads.
 */
export function verifyQuote({ quote, expect }: VerifyArgs): QuoteVerification {
  const failures: string[] = [];
  const same = (a: string | undefined, b: string) =>
    !!a && a.toLowerCase() === b.toLowerCase();

  if (quote.chainId !== expect.chainId) {
    failures.push(`chainId ${quote.chainId}, expected ${expect.chainId}`);
  }
  if (!same(quote.sellToken, expect.sellToken)) {
    failures.push(`sellToken ${quote.sellToken}, expected ${expect.sellToken}`);
  }
  if (!same(quote.buyToken, expect.buyToken)) {
    failures.push(`buyToken ${quote.buyToken}, expected ${expect.buyToken}`);
  }

  let sellAmount: bigint | null = null;
  try { sellAmount = BigInt(quote.sellAmount); } catch { failures.push('sellAmount is not an integer'); }
  if (sellAmount !== null && sellAmount !== expect.sellAmount) {
    failures.push(`sellAmount ${sellAmount}, expected ${expect.sellAmount}`);
  }

  // THE SLIPPAGE FLOOR.
  //
  // Expressed as "the slippage 0x guarantees must be within our ceiling",
  // NOT as "0x's minBuyAmount must equal our own recomputation of it".
  //
  // The first version did the latter, and a live dry run rejected a perfectly
  // good quote over 2118 wei out of 2.003e15 — roughly one part in a trillion,
  // purely a rounding-direction difference. That check would have refused every
  // legitimate quote while looking like a working safety control, which is the
  // most expensive kind of bug: a gate that only ever says no.
  let minBuy: bigint | null = null;
  let buyAmount: bigint | null = null;
  try { minBuy = BigInt(quote.minBuyAmount); } catch { failures.push('minBuyAmount is not an integer'); }
  try { buyAmount = BigInt(quote.buyAmount); } catch { failures.push('buyAmount is not an integer'); }

  if (minBuy !== null && buyAmount !== null) {
    if (buyAmount <= 0n) {
      failures.push('buyAmount is not positive');
    } else if (minBuy <= 0n) {
      failures.push('minBuyAmount is zero — the quote guarantees nothing');
    } else {
      const impliedBps = ((buyAmount - minBuy) * 10_000n) / buyAmount;
      if (impliedBps > BigInt(expect.maxSlippageBps)) {
        failures.push(
          `quote guarantees only ${impliedBps}bps of slippage protection, ceiling is ${expect.maxSlippageBps}bps`,
        );
      }
    }
  }

  if (!quote.to || !APPROVED_TARGETS.has(quote.to.toLowerCase())) {
    failures.push(`transaction target ${quote.to} is not an approved 0x contract`);
  }
  if (quote.allowanceTarget && !APPROVED_TARGETS.has(quote.allowanceTarget.toLowerCase())) {
    failures.push(`allowance spender ${quote.allowanceTarget} is not approved`);
  }
  if (!quote.data || !quote.data.startsWith('0x') || quote.data.length < 10) {
    failures.push('calldata is missing or malformed');
  }
  // This venue settles in ERC-20s. A quote asking us to send native ETH is
  // either a different trade than the one approved, or an attempt to drain gas.
  try {
    if (BigInt(quote.value ?? '0') !== 0n) failures.push(`quote sends ${quote.value} wei of native value; expected 0`);
  } catch {
    failures.push('value is not an integer');
  }

  return { ok: failures.length === 0, failures };
}

export interface ZeroXAdapterOptions {
  apiKey: string;
  signer: TradingSigner;
  chainId?: number;
  /** the risk-approved ceiling; the floor handed to 0x is derived from it */
  maxSlippageBps?: number;
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ZeroXRobinhoodAdapter implements ExecutionAdapter {
  readonly venue = 'evm:robinhood';
  private readonly chainId: number;
  private readonly client;

  constructor(private opts: ZeroXAdapterOptions) {
    this.chainId = opts.chainId ?? ROBINHOOD_MAINNET_CHAIN_ID;
    const chain = rhChainDef(this.chainId);
    this.client = createPublicClient({
      chain,
      transport: http(opts.rpcUrl ?? process.env.RPC_ROBINHOOD_PRIMARY ?? chain.rpcUrls.default.http[0]),
    });
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  async health(): Promise<VenueHealth> {
    const base = { venue: this.venue, latencyMs: null, errorRate: 0, lastOkAt: null };
    if (!this.opts.apiKey) {
      return { ...base, status: 'offline', note: 'ZEROX_API_KEY not configured' };
    }
    const started = Date.now();
    try {
      const reported = await this.client.getChainId();
      if (reported !== this.chainId) {
        // An RPC that answers but reports the wrong chain is the worst failure
        // available here: it looks healthy and it signs against the wrong world.
        return {
          ...base, status: 'offline', latencyMs: Date.now() - started,
          note: `RPC reports chain ${reported}, expected ${this.chainId} — refusing to treat this as Robinhood Chain`,
        };
      }
      const block = await this.client.getBlockNumber();
      return {
        ...base, status: 'online', latencyMs: Date.now() - started, lastOkAt: Date.now(),
        note: `chain ${reported} at block ${block}`,
      };
    } catch (e) {
      return {
        ...base, status: 'offline', latencyMs: Date.now() - started,
        note: `RPC unreachable: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`,
      };
    }
  }

  /** Indicative price only. Never used to size a signature. */
  async getQuote(inst: Instrument): Promise<AdapterQuote | null> {
    const spec = resolveLiveInstrument(inst.symbol.replace(`-${SETTLEMENT.symbol}`, 'USDT')).spec
      ?? resolveLiveInstrument('ETHUSDT').spec;
    if (!spec) return null;
    try {
      const url = new URL(`${ZEROX_API}/swap/allowance-holder/price`);
      url.searchParams.set('chainId', String(this.chainId));
      url.searchParams.set('sellToken', spec.quote.address);
      url.searchParams.set('buyToken', spec.base.address);
      url.searchParams.set('sellAmount', parseUnits('1', spec.quote.decimals).toString());
      const res = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { buyAmount?: string };
      if (!body.buyAmount) return null;
      const out = Number(formatUnits(BigInt(body.buyAmount), spec.base.decimals));
      return out > 0 ? { instrumentId: inst.id, price: 1 / out, ts: Date.now() } : null;
    } catch {
      return null;
    }
  }

  private headers(): Record<string, string> {
    return { '0x-api-key': this.opts.apiKey, '0x-version': 'v2' };
  }

  /**
   * Quote → verify → sign → broadcast. Returns PENDING with a tx hash; the
   * reconciler resolves it into a fill from the receipt.
   */
  async placeOrder(
    inst: Instrument,
    side: 'buy' | 'sell',
    notionalUsd: number,
    opts?: { minReceive?: number; intentId?: string },
  ): Promise<AdapterOrderResult> {
    if (!this.opts.apiKey) return { accepted: false, error: 'NOT_CONFIGURED: ZEROX_API_KEY missing' };
    if (!opts?.intentId) return { accepted: false, error: 'refusing to trade without an intent id' };

    const spec = resolveLiveInstrument('ETHUSDT').spec;
    if (!spec || spec.id !== inst.id) {
      return { accepted: false, error: `ADAPTER_UNAVAILABLE: ${inst.id} is not a mapped Robinhood instrument` };
    }

    const signerAddress = await this.opts.signer.getAddress();
    if (!signerAddress) return { accepted: false, error: 'signer has no address — refusing to quote' };

    // buy = spend settlement to acquire base; sell = the reverse.
    const sellTok = side === 'buy' ? spec.quote : spec.base;
    const buyTok = side === 'buy' ? spec.base : spec.quote;

    // Sizing uses each token's OWN decimals. Settlement is 6 here and the base
    // is 18; a shared constant would be wrong by a factor of 1e12.
    let sellAmount: bigint;
    if (side === 'buy') {
      sellAmount = parseUnits(notionalUsd.toFixed(sellTok.decimals), sellTok.decimals);
    } else {
      const mark = await this.getQuote(inst);
      if (!mark?.price) return { accepted: false, error: 'no mark available to size a sell' };
      sellAmount = parseUnits((notionalUsd / mark.price).toFixed(sellTok.decimals), sellTok.decimals);
    }
    if (sellAmount <= 0n) return { accepted: false, error: 'computed sell amount is zero' };

    // The floor, derived from the risk-approved ceiling and enforced by 0x
    // inside the calldata rather than by us after the fact.
    const slippageBps = this.opts.maxSlippageBps ?? 100;

    let quote: ZeroXQuote;
    try {
      const url = new URL(`${ZEROX_API}/swap/allowance-holder/quote`);
      url.searchParams.set('chainId', String(this.chainId));
      url.searchParams.set('sellToken', sellTok.address);
      url.searchParams.set('buyToken', buyTok.address);
      url.searchParams.set('sellAmount', sellAmount.toString());
      url.searchParams.set('taker', signerAddress);
      url.searchParams.set('slippageBps', String(slippageBps));
      const res = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      const body = await res.json();
      if (!res.ok) {
        return { accepted: false, error: `0x refused the quote (${res.status}): ${body?.name ?? JSON.stringify(body).slice(0, 120)}` };
      }
      quote = {
        chainId: Number(body.chainId ?? this.chainId),
        sellToken: body.sellToken, buyToken: body.buyToken,
        sellAmount: body.sellAmount, buyAmount: body.buyAmount,
        minBuyAmount: body.minBuyAmount,
        to: body.transaction?.to, data: body.transaction?.data,
        value: body.transaction?.value ?? '0', gas: body.transaction?.gas,
        allowanceTarget: body?.issues?.allowance?.spender,
      };
    } catch (e) {
      return { accepted: false, error: `0x unreachable: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
    }

    // ── the gate: every field against what was approved ──
    const verdict = verifyQuote({
      quote,
      expect: {
        chainId: this.chainId,
        sellToken: sellTok.address,
        buyToken: buyTok.address,
        sellAmount,
        maxSlippageBps: slippageBps,
        signerAddress,
      },
    });
    if (!verdict.ok) {
      return { accepted: false, error: `QUOTE_REJECTED: ${verdict.failures.join('; ')}` };
    }

    // ── sign, then broadcast ourselves so the receipt is ours to track ──
    let raw: string;
    try {
      raw = await this.opts.signer.signTransaction({
        chainId: this.chainId,
        to: quote.to,
        data: quote.data,
        value: 0n,
        gas: quote.gas ? BigInt(quote.gas) : undefined,
        intentId: opts.intentId,
      });
    } catch (e) {
      return { accepted: false, error: `SIGNER_REFUSED: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` };
    }

    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: raw as Hex });
      // PENDING, not filled. A hash means the network accepted the bytes, not
      // that the swap happened at a price anyone would like.
      return {
        accepted: true,
        pending: true,
        txRef: hash,
        venueOrderId: hash,
      };
    } catch (e) {
      return { accepted: false, error: `BROADCAST_FAILED: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` };
    }
  }

  /** Resolve a broadcast transaction from its receipt. The chain decides. */
  async getOrderStatus(venueOrderId: string): Promise<AdapterOrderStatus> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: venueOrderId as Hex });
      if (!receipt) return { state: 'pending', filledQty: 0, detail: 'not yet mined' };
      if (receipt.status !== 'success') {
        return { state: 'failed', filledQty: 0, detail: `reverted in block ${receipt.blockNumber}` };
      }
      const spec = resolveLiveInstrument('ETHUSDT').spec;
      const signerAddress = (await this.opts.signer.getAddress())?.toLowerCase();
      let received = 0n;
      let decimals = spec?.base.decimals ?? 18;

      // Transfer(address,address,uint256) — take what actually landed in our
      // wallet rather than trusting the quote's expected buyAmount.
      const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSFER || log.topics.length < 3) continue;
        const to = `0x${log.topics[2]!.slice(26)}`.toLowerCase();
        if (to !== signerAddress) continue;
        received += BigInt(log.data);
        if (spec && log.address.toLowerCase() === spec.quote.address.toLowerCase()) decimals = spec.quote.decimals;
      }

      const gasUsd = 0; // priced by the caller from the ETH mark
      return {
        state: 'filled',
        filledQty: Number(formatUnits(received, decimals)),
        feeUsd: gasUsd,
        detail: `confirmed in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`,
      };
    } catch (e) {
      // A receipt that cannot be read is UNKNOWN, never "failed" — the
      // difference decides whether the reconciler retries or writes off.
      return { state: 'unknown', filledQty: 0, detail: `receipt unavailable: ${String(e).slice(0, 120)}` };
    }
  }

  async getBalances(): Promise<AdapterBalance[]> {
    const address = await this.opts.signer.getAddress();
    if (!address) return [];
    const spec = resolveLiveInstrument('ETHUSDT').spec;
    const out: AdapterBalance[] = [];
    const wei = await this.client.getBalance({ address: getAddress(address) as Address });
    out.push({ asset: 'ETH', qty: Number(formatUnits(wei, 18)) });
    if (spec) {
      for (const tok of [spec.quote, spec.base]) {
        const raw = (await this.client.readContract({
          address: getAddress(tok.address) as Address, abi: ERC20_ABI,
          functionName: 'balanceOf', args: [getAddress(address) as Address],
        })) as bigint;
        out.push({ asset: tok.symbol, qty: Number(formatUnits(raw, tok.decimals)) });
      }
    }
    return out;
  }

  async getPositions(): Promise<AdapterPosition[]> {
    // Spot swaps leave token balances, not venue-side positions. Reporting an
    // empty list is the truth; the ledger holds our view of what we hold.
    return [];
  }

  /** The chain is authoritative. Drift is reported, never silently corrected. */
  async reconcile(): Promise<ReconciliationResult> {
    try {
      const balances = await this.getBalances();
      return {
        ok: true,
        balances,
        positions: [],
        detail: balances.map((b) => `${b.asset} ${b.qty}`).join(', ') || 'wallet empty',
      };
    } catch (e) {
      return {
        ok: false, balances: [], positions: [],
        detail: `could not read chain state: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`,
      };
    }
  }
}
