import {
  createPublicClient, decodeFunctionData, encodeFunctionData, formatUnits, getAddress, http, parseUnits,
  type Address, type Hex,
} from 'viem';
import { ROBINHOOD_MAINNET_CHAIN_ID, type Instrument, type VenueHealth } from '@punklabz/shared';
import type {
  AdapterBalance, AdapterOrderResult, AdapterOrderStatus, AdapterPosition,
  AdapterQuote, ExecutionAdapter, FundingTransfer, ReconciliationResult,
} from '../adapters.js';
import type { TradingSigner } from '../signing/signer.js';
import type { DB } from '../../db/db.js';
import { rhChainDef } from '../../chain/rhChain.js';
import { probeEndpoints } from '../../chain/rhChain.js';
import { ZEROX_ALLOWANCE_HOLDER, resolveLiveInstrument } from '../instrumentResolver.js';
import { SETTLEMENT } from '../instruments.js';
import { TransactionCoordinator } from '../transactionCoordinator.js';

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
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const ALLOWANCE_HOLDER_ABI = [{
  name: 'exec', type: 'function', stateMutability: 'payable',
  inputs: [
    { name: 'operator', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
  ],
  outputs: [{ name: 'result', type: 'bytes' }],
}] as const;

const SETTLER_ABI = [{
  name: 'execute', type: 'function', stateMutability: 'payable',
  inputs: [
    {
      name: 'slippage', type: 'tuple', components: [
        { name: 'recipient', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'minAmountOut', type: 'uint256' },
      ],
    },
    { name: 'actions', type: 'bytes[]' },
    { name: 'zidAndAffiliate', type: 'bytes32' },
  ],
  outputs: [{ type: 'bool' }],
}] as const;

const ZEROX_DEPLOYER = '0x00000000000004533Fe15556B1E086BB1A72cEae' as Address;
const ZEROX_DEPLOYER_ABI = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'prev', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint128' }], outputs: [{ type: 'address' }] },
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
  gasPrice?: string;
  quotedAt?: number;
}

export interface QuoteVerification {
  ok: boolean;
  failures: string[];
  settlerAddress?: string;
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
    minBuyAmount?: bigint;
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
  let settlerAddress: string | undefined;
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
      if (expect.minBuyAmount !== undefined && minBuy < expect.minBuyAmount) {
        failures.push(`minBuyAmount ${minBuy} is below risk floor ${expect.minBuyAmount}`);
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
  } else {
    try {
      const decoded = decodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, data: quote.data as Hex });
      if (decoded.functionName !== 'exec') throw new Error(`unexpected function ${decoded.functionName}`);
      const [operator, token, amount, target, settlerData] = decoded.args;
      if (!same(token, expect.sellToken)) failures.push(`calldata token ${token}, expected ${expect.sellToken}`);
      if (amount !== expect.sellAmount) failures.push(`calldata amount ${amount}, expected ${expect.sellAmount}`);
      if (!same(operator, target)) failures.push(`calldata operator ${operator} does not match target ${target}`);
      settlerAddress = target;
      const inner = decodeFunctionData({ abi: SETTLER_ABI, data: settlerData });
      if (inner.functionName !== 'execute') throw new Error(`unexpected Settler function ${inner.functionName}`);
      const [slippage, actions] = inner.args;
      if (!same(slippage.recipient, expect.signerAddress)) {
        failures.push(`calldata recipient ${slippage.recipient}, expected signer ${expect.signerAddress}`);
      }
      if (!same(slippage.buyToken, expect.buyToken)) {
        failures.push(`calldata buy token ${slippage.buyToken}, expected ${expect.buyToken}`);
      }
      if (minBuy !== null && slippage.minAmountOut !== minBuy) {
        failures.push(`calldata minimum ${slippage.minAmountOut} does not match quote minimum ${minBuy}`);
      }
      if (expect.minBuyAmount !== undefined && slippage.minAmountOut < expect.minBuyAmount) {
        failures.push(`calldata minimum ${slippage.minAmountOut} is below risk floor ${expect.minBuyAmount}`);
      }
      if (actions.length === 0) failures.push('calldata contains no settlement actions');
    } catch (error) {
      failures.push(`calldata is not a valid AllowanceHolder exec: ${String(error).slice(0, 100)}`);
    }
  }
  if (!quote.quotedAt || Date.now() - quote.quotedAt > 15_000 || quote.quotedAt > Date.now() + 1_000) {
    failures.push('quote timestamp is missing, stale, or in the future');
  }
  // This venue settles in ERC-20s. A quote asking us to send native ETH is
  // either a different trade than the one approved, or an attempt to drain gas.
  try {
    if (BigInt(quote.value ?? '0') !== 0n) failures.push(`quote sends ${quote.value} wei of native value; expected 0`);
  } catch {
    failures.push('value is not an integer');
  }

  return { ok: failures.length === 0, failures, settlerAddress };
}

export interface ZeroXAdapterOptions {
  apiKey: string;
  signer: TradingSigner;
  chainId?: number;
  db?: DB;
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  probeImpl?: typeof probeEndpoints;
}

interface IndexedInternalTransfer {
  index?: unknown;
  txHash?: unknown;
  blockNumber?: unknown;
  to?: unknown;
  value?: unknown;
  success?: unknown;
}

export function parseIndexedEthFunding(
  body: unknown,
  txHash: string,
  walletAddress: string,
): Array<FundingTransfer & { blockNumber: bigint; valueWei: bigint }> {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error('trace indexer returned an invalid response');
  const expectedHash = txHash.toLowerCase();
  const wallet = walletAddress.toLowerCase();
  const transfers: Array<FundingTransfer & { blockNumber: bigint; valueWei: bigint }> = [];
  for (const raw of items as IndexedInternalTransfer[]) {
    if (raw.success !== true || String(raw.txHash).toLowerCase() !== expectedHash) continue;
    if (String(raw.to).toLowerCase() !== wallet) continue;
    const index = Number(raw.index);
    const blockNumber = BigInt(String(raw.blockNumber));
    const valueWei = BigInt(String(raw.value));
    if (!Number.isInteger(index) || index < 0 || blockNumber < 1n || valueWei <= 0n) {
      throw new Error('trace indexer returned a malformed ETH transfer');
    }
    transfers.push({
      asset: 'ETH',
      qty: Number(formatUnits(valueWei, 18)),
      txRef: txHash,
      logIndex: index,
      blockNumber,
      valueWei,
    });
  }
  return transfers;
}

export class ZeroXRobinhoodAdapter implements ExecutionAdapter {
  readonly venue = 'evm:robinhood';
  private readonly chainId: number;
  private readonly client;
  private readonly coordinator: TransactionCoordinator | null;

  constructor(private opts: ZeroXAdapterOptions) {
    this.chainId = opts.chainId ?? ROBINHOOD_MAINNET_CHAIN_ID;
    const chain = rhChainDef(this.chainId);
    this.client = createPublicClient({
      chain,
      transport: http(opts.rpcUrl ?? process.env.RPC_ROBINHOOD_PRIMARY ?? chain.rpcUrls.default.http[0]),
    });
    this.coordinator = opts.db ? new TransactionCoordinator(opts.db, opts.signer, this.client) : null;
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private async runtimeSafety(signerAddress: string, ethUsd: number | undefined): Promise<string | null> {
    if (this.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
      return `adapter chain ${this.chainId}, required ${ROBINHOOD_MAINNET_CHAIN_ID}`;
    }
    try {
      const [reported, localBlock, endpoints, gasBalance, fees] = await Promise.all([
        this.client.getChainId(),
        this.client.getBlockNumber(),
        (this.opts.probeImpl ?? probeEndpoints)(ROBINHOOD_MAINNET_CHAIN_ID),
        this.client.getBalance({ address: getAddress(signerAddress) as Address }),
        this.client.estimateFeesPerGas(),
      ]);
      if (reported !== ROBINHOOD_MAINNET_CHAIN_ID) {
        return `RPC reports chain ${reported}, required ${ROBINHOOD_MAINNET_CHAIN_ID}`;
      }
      const primary = endpoints.find((endpoint) => endpoint.label === 'primary');
      if (!primary?.ok || primary.blockNumber === null) return 'configured primary Robinhood RPC is unavailable';
      const healthyBlocks = endpoints.filter((endpoint) => endpoint.ok && endpoint.blockNumber !== null)
        .map((endpoint) => endpoint.blockNumber!);
      const bestBlock = Math.max(Number(localBlock), ...healthyBlocks);
      if (bestBlock - Number(localBlock) > 3) {
        return `execution RPC is ${bestBlock - Number(localBlock)} blocks behind`;
      }
      const maxFee = fees.maxFeePerGas;
      if (!maxFee || maxFee <= 0n) return 'RPC did not return usable gas pricing';
      const requiredEth = Math.max(0.005, Number(formatUnits(maxFee * 400_000n * 20n, 18)));
      const heldEth = Number(formatUnits(gasBalance, 18));
      if (!ethUsd || ethUsd <= 0) return 'ETH/USD reference price is missing';
      const gasFloorUsd = this.opts.db
        ? ((this.opts.db.prepare(`SELECT gas_reserve_critical_usd g FROM live_config WHERE id=1`).get() as { g: number } | undefined)?.g ?? 3)
        : 3;
      if (heldEth < requiredEth || heldEth * ethUsd < gasFloorUsd) {
        return `${heldEth.toFixed(6)} ETH gas reserve is below ${requiredEth.toFixed(6)} ETH / $${gasFloorUsd} minimum`;
      }
      return null;
    } catch (error) {
      return `runtime chain/gas check failed: ${String(error).slice(0, 140)}`;
    }
  }

  private async verifySettler(address: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const alleged = getAddress(address) as Address;
      const blockNumber = await this.client.getBlockNumber();
      const [current, previous, code] = await Promise.all([
        this.client.readContract({
          address: ZEROX_DEPLOYER, abi: ZEROX_DEPLOYER_ABI, functionName: 'ownerOf', args: [2n], blockNumber,
        }) as Promise<Address>,
        this.client.readContract({
          address: ZEROX_DEPLOYER, abi: ZEROX_DEPLOYER_ABI, functionName: 'prev', args: [2n], blockNumber,
        }) as Promise<Address>,
        this.client.getBytecode({ address: alleged, blockNumber }),
      ]);
      const genuine = alleged.toLowerCase() === current.toLowerCase()
        || alleged.toLowerCase() === previous.toLowerCase();
      if (!genuine) return { ok: false, detail: `${alleged} is not the current or previous 0x taker Settler` };
      if (!code || code === '0x') return { ok: false, detail: `${alleged} has no bytecode` };
      return { ok: true, detail: `${alleged} verified against 0x registry at block ${blockNumber}` };
    } catch (error) {
      return { ok: false, detail: `0x Settler registry verification failed: ${String(error).slice(0, 120)}` };
    }
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
      const assets = await this.verifyCoreAssets();
      if (!assets.ok) {
        return {
          ...base, status: 'offline', latencyMs: Date.now() - started,
          note: `core asset verification failed: ${assets.failures.join('; ')}`,
        };
      }
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

  async verifyCoreAssets(): Promise<{ ok: boolean; failures: string[] }> {
    const spec = resolveLiveInstrument('ETHUSDT').spec;
    if (!spec) return { ok: false, failures: ['WETH/USDG mapping missing'] };
    const failures: string[] = [];
    for (const token of [spec.quote, spec.base]) {
      try {
        const address = getAddress(token.address) as Address;
        const [code, decimals, symbol] = await Promise.all([
          this.client.getBytecode({ address }),
          this.client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
          this.client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
        ]);
        if (!code || code === '0x') failures.push(`${token.symbol} has no bytecode at ${token.address}`);
        if (Number(decimals) !== token.decimals) failures.push(`${token.symbol} decimals ${decimals}, expected ${token.decimals}`);
        if (String(symbol).toUpperCase() !== token.symbol.toUpperCase()) failures.push(`${token.address} reports symbol ${symbol}, expected ${token.symbol}`);
      } catch (error) {
        failures.push(`${token.symbol} verification failed: ${String(error).slice(0, 100)}`);
      }
    }
    try {
      const [holderCode, registryCode, current] = await Promise.all([
        this.client.getBytecode({ address: getAddress(ZEROX_ALLOWANCE_HOLDER) as Address }),
        this.client.getBytecode({ address: ZEROX_DEPLOYER }),
        this.client.readContract({
          address: ZEROX_DEPLOYER, abi: ZEROX_DEPLOYER_ABI, functionName: 'ownerOf', args: [2n],
        }) as Promise<Address>,
      ]);
      if (!holderCode || holderCode === '0x') failures.push('0x AllowanceHolder has no bytecode');
      if (!registryCode || registryCode === '0x') failures.push('0x Settler registry has no bytecode');
      const settler = await this.verifySettler(current);
      if (!settler.ok) failures.push(settler.detail);
    } catch (error) {
      failures.push(`0x execution contract verification failed: ${String(error).slice(0, 120)}`);
    }
    return { ok: failures.length === 0, failures };
  }

  async estimateGasReserveEth(transactionCount: number): Promise<number> {
    if (!Number.isInteger(transactionCount) || transactionCount <= 0) throw new Error('transaction count must be positive');
    const fees = await this.client.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas;
    if (!maxFee || maxFee <= 0n) throw new Error('RPC did not return a usable max fee per gas');
    // 400k covers a swap; approvals are normally smaller. The reserve is a
    // capacity gate, not a transaction gas limit.
    const requiredWei = maxFee * 400_000n * BigInt(transactionCount);
    return Number(formatUnits(requiredWei, 18));
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

  async getExecutableQuote(inst: Instrument): Promise<AdapterQuote | null> {
    const spec = resolveLiveInstrument(inst.symbol.replace(`-${SETTLEMENT.symbol}`, 'USDT')).spec
      ?? resolveLiveInstrument('ETHUSDT').spec;
    const taker = await this.opts.signer.getAddress();
    if (!spec || !taker) return null;
    try {
      const url = new URL(`${ZEROX_API}/swap/allowance-holder/quote`);
      url.searchParams.set('chainId', String(this.chainId));
      url.searchParams.set('sellToken', spec.quote.address);
      url.searchParams.set('buyToken', spec.base.address);
      url.searchParams.set('sellAmount', parseUnits('1', spec.quote.decimals).toString());
      url.searchParams.set('taker', taker);
      url.searchParams.set('slippageBps', '35');
      const res = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { buyAmount?: string; liquidityAvailable?: boolean };
      if (!body.buyAmount || body.liquidityAvailable === false) return null;
      const out = Number(formatUnits(BigInt(body.buyAmount), spec.base.decimals));
      return out > 0 ? { instrumentId: inst.id, price: 1 / out, ts: Date.now() } : null;
    } catch {
      return null;
    }
  }

  async getExecutableSellQuote(inst: Instrument, quantity: number): Promise<AdapterQuote | null> {
    const spec = resolveLiveInstrument(inst.symbol.replace(`-${SETTLEMENT.symbol}`, 'USDT')).spec
      ?? resolveLiveInstrument('ETHUSDT').spec;
    const taker = await this.opts.signer.getAddress();
    if (!spec || !taker || !Number.isFinite(quantity) || quantity <= 0) return null;
    try {
      const url = new URL(`${ZEROX_API}/swap/allowance-holder/quote`);
      url.searchParams.set('chainId', String(this.chainId));
      url.searchParams.set('sellToken', spec.base.address);
      url.searchParams.set('buyToken', spec.quote.address);
      url.searchParams.set('sellAmount', parseUnits(quantity.toFixed(spec.base.decimals), spec.base.decimals).toString());
      url.searchParams.set('taker', taker);
      url.searchParams.set('slippageBps', '35');
      const res = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        minBuyAmount?: string;
        buyAmount?: string;
        liquidityAvailable?: boolean;
      };
      if (body.liquidityAvailable === false) return null;
      // NAV uses the calldata-enforced minimum, not 0x's optimistic output.
      const minimum = body.minBuyAmount ?? body.buyAmount;
      if (!minimum) return null;
      const out = Number(formatUnits(BigInt(minimum), spec.quote.decimals));
      return out > 0 ? { instrumentId: inst.id, price: out / quantity, ts: Date.now() } : null;
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
    opts?: {
      minReceive?: number;
      intentId?: string;
      orderId?: number;
      accountId?: number;
      maxSlippageBps?: number;
      expectedPrice?: number;
      grossEdgeBps?: number;
      safetyBufferBps?: number;
      exactSellQuantity?: number;
    },
  ): Promise<AdapterOrderResult> {
    if (!this.opts.apiKey) return { accepted: false, error: 'NOT_CONFIGURED: ZEROX_API_KEY missing' };
    if (!opts?.intentId) return { accepted: false, error: 'refusing to trade without an intent id' };
    if (!opts.orderId || !opts.accountId) return { accepted: false, error: 'refusing to trade without durable order/account ids' };
    if (!this.coordinator) return { accepted: false, error: 'transaction coordinator is not configured' };

    const spec = resolveLiveInstrument('ETHUSDT').spec;
    if (!spec || spec.id !== inst.id) {
      return { accepted: false, error: `ADAPTER_UNAVAILABLE: ${inst.id} is not a mapped Robinhood instrument` };
    }

    const signerAddress = await this.opts.signer.getAddress();
    if (!signerAddress) return { accepted: false, error: 'signer has no address — refusing to quote' };
    const runtimeFailure = await this.runtimeSafety(signerAddress, opts.expectedPrice);
    if (runtimeFailure) return { accepted: false, error: `RUNTIME_PREFLIGHT_REJECTED: ${runtimeFailure}` };

    // buy = spend settlement to acquire base; sell = the reverse.
    const sellTok = side === 'buy' ? spec.quote : spec.base;
    const buyTok = side === 'buy' ? spec.base : spec.quote;

    // Sizing uses each token's OWN decimals. Settlement is 6 here and the base
    // is 18; a shared constant would be wrong by a factor of 1e12.
    let sellAmount: bigint;
    if (side === 'buy') {
      sellAmount = parseUnits(notionalUsd.toFixed(sellTok.decimals), sellTok.decimals);
    } else {
      if (opts.exactSellQuantity !== undefined) {
        if (!Number.isFinite(opts.exactSellQuantity) || opts.exactSellQuantity <= 0) {
          return { accepted: false, error: 'exact sell quantity must be positive' };
        }
        sellAmount = parseUnits(opts.exactSellQuantity.toFixed(sellTok.decimals), sellTok.decimals);
      } else {
        const mark = await this.getQuote(inst);
        if (!mark?.price) return { accepted: false, error: 'no mark available to size a sell' };
        sellAmount = parseUnits((notionalUsd / mark.price).toFixed(sellTok.decimals), sellTok.decimals);
      }
    }
    if (sellAmount <= 0n) return { accepted: false, error: 'computed sell amount is zero' };

    // The floor, derived from the risk-approved ceiling and enforced by 0x
    // inside the calldata rather than by us after the fact.
    const slippageBps = Math.min(35, Math.max(0, opts.maxSlippageBps ?? 35));

    // Establish the bounded allowance before requesting the firm swap quote.
    // Waiting for an approval receipt can take longer than the quote's entire
    // 15-second lifetime, so quoting first would guarantee stale calldata.
    const spender = getAddress(ZEROX_ALLOWANCE_HOLDER) as Address;
    let approvalConsumedGas = false;
    try {
      const current = (await this.client.readContract({
        address: getAddress(sellTok.address) as Address, abi: ERC20_ABI,
        functionName: 'allowance', args: [getAddress(signerAddress) as Address, spender],
      })) as bigint;

      if (current < sellAmount) {
        const approveData = encodeFunctionData({
          abi: ERC20_ABI, functionName: 'approve', args: [spender, sellAmount],
        });
        const approval = await this.coordinator.submit({
          orderId: opts.orderId, accountId: opts.accountId, purpose: 'allowance',
          idempotencyKey: `${opts.intentId}:allowance`, chainId: this.chainId,
          walletAddress: signerAddress, to: getAddress(sellTok.address), data: approveData,
          value: 0n, gas: 120_000n,
        });
        // Broadcasting the swap against an unconfirmed approval is a race that
        // spends gas when it loses.
        const receipt = await this.client.waitForTransactionReceipt({ hash: approval.hash as Hex, timeout: 90_000 });
        if (receipt.status !== 'success') {
          this.opts.db?.prepare(
            `UPDATE execution_transactions SET state='reverted', block_number=?, block_hash=?, error=?, updated_at=? WHERE id=?`,
          ).run(Number(receipt.blockNumber), receipt.blockHash, 'approval reverted', Date.now(), approval.transactionId);
          return { accepted: false, error: `APPROVAL_FAILED: reverted in block ${receipt.blockNumber}` };
        }
        this.opts.db?.prepare(
          `UPDATE execution_transactions SET state='confirmed', block_number=?, block_hash=?, confirmations=1,
           signed_payload=NULL, updated_at=? WHERE id=?`,
        ).run(Number(receipt.blockNumber), receipt.blockHash, Date.now(), approval.transactionId);
        const approvalGas = receipt.gasUsed * receipt.effectiveGasPrice;
        this.opts.db?.prepare(
          `INSERT OR IGNORE INTO execution_asset_ledger
            (execution_account_id, order_id, transaction_id, asset, qty_delta, event_type, tx_ref, log_index, ts)
           VALUES (?, ?, ?, 'ETH', ?, 'gas', ?, -1, ?)`,
        ).run(opts.accountId, opts.orderId, approval.transactionId,
          String(-Number(formatUnits(approvalGas, 18))), approval.hash, Date.now());
        approvalConsumedGas = true;
      }
    } catch (e) {
      return { accepted: false, error: `APPROVAL_FAILED: ${String(e instanceof Error ? e.message : e).slice(0, 180)}` };
    }
    if (approvalConsumedGas) {
      const postApprovalFailure = await this.runtimeSafety(signerAddress, opts.expectedPrice);
      if (postApprovalFailure) {
        return { accepted: false, error: `POST_APPROVAL_PREFLIGHT_REJECTED: ${postApprovalFailure}` };
      }
    }

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
      if (body?.liquidityAvailable === false) {
        return { accepted: false, error: '0x refused the quote: liquidity is unavailable' };
      }
      quote = {
        chainId: Number(body.chainId ?? this.chainId),
        sellToken: body.sellToken, buyToken: body.buyToken,
        sellAmount: body.sellAmount, buyAmount: body.buyAmount,
        minBuyAmount: body.minBuyAmount,
        to: body.transaction?.to, data: body.transaction?.data,
        value: body.transaction?.value ?? '0', gas: body.transaction?.gas,
        allowanceTarget: body?.issues?.allowance?.spender,
        gasPrice: body.transaction?.gasPrice,
        quotedAt: Date.now(),
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
        minBuyAmount: opts.minReceive !== undefined
          ? parseUnits(opts.minReceive.toFixed(buyTok.decimals), buyTok.decimals)
          : undefined,
      },
    });
    if (!verdict.ok) {
      return { accepted: false, error: `QUOTE_REJECTED: ${verdict.failures.join('; ')}` };
    }
    const settler = verdict.settlerAddress ? await this.verifySettler(verdict.settlerAddress) : null;
    if (!settler?.ok) {
      return { accepted: false, error: `QUOTE_REJECTED: ${settler?.detail ?? 'calldata Settler missing'}` };
    }

    if (Date.now() - (quote.quotedAt ?? 0) > 15_000) {
      return { accepted: false, error: 'QUOTE_REJECTED: quote is older than 15 seconds' };
    }

    // Final pre-sign edge check against the executable amounts. The 0x output
    // already includes venue spread/fees; gas and a fixed safety margin are
    // added explicitly. Operator path tests have no strategy edge and are
    // recorded/excluded from promotion rather than pretending to be alpha.
    const sellQty = Number(formatUnits(BigInt(quote.sellAmount), sellTok.decimals));
    const buyQty = Number(formatUnits(BigInt(quote.buyAmount), buyTok.decimals));
    const executable = side === 'buy' ? sellQty / buyQty : buyQty / sellQty;
    if (!opts.expectedPrice || opts.expectedPrice <= 0) {
      return { accepted: false, error: 'REFERENCE_PRICE_REJECTED: ETH/USD reference price is missing' };
    }
    const referenceDeviation = Math.abs(executable / opts.expectedPrice - 1);
    if (!Number.isFinite(referenceDeviation) || referenceDeviation > 0.01) {
      return {
        accepted: false,
        error: `REFERENCE_PRICE_REJECTED: executable WETH/USDG deviates ${(referenceDeviation * 100).toFixed(2)}% from ETH/USD`,
      };
    }

    if (opts.grossEdgeBps !== undefined) {
      if (!quote.gasPrice) {
        return { accepted: false, error: 'FINAL_EDGE_REJECTED: firm quote did not include gas price' };
      }
      const adverseBps = Math.max(0,
        ((executable - opts.expectedPrice) / opts.expectedPrice) * 10_000 * (side === 'buy' ? 1 : -1));
      const gasWei = BigInt(quote.gas ?? '400000') * BigInt(quote.gasPrice ?? '0');
      const gasUsd = Number(formatUnits(gasWei, 18)) * opts.expectedPrice;
      const gasBps = notionalUsd > 0 ? (gasUsd / notionalUsd) * 10_000 : Infinity;
      const finalNet = opts.grossEdgeBps - adverseBps - gasBps - (opts.safetyBufferBps ?? 10);
      if (!Number.isFinite(finalNet) || finalNet <= 0) {
        return {
          accepted: false,
          error: `FINAL_EDGE_REJECTED: ${finalNet.toFixed(1)}bps after executable price, gas, and safety margin`,
        };
      }
    }

    // ── sign, then broadcast ourselves so the receipt is ours to track ──
    try {
      const submitted = await this.coordinator.submit({
        orderId: opts.orderId, accountId: opts.accountId, purpose: 'swap',
        idempotencyKey: `${opts.intentId}:swap`, chainId: this.chainId,
        walletAddress: signerAddress, to: quote.to, data: quote.data, value: 0n,
        gas: quote.gas ? BigInt(quote.gas) : 400_000n,
        expiresAt: (quote.quotedAt ?? 0) + 15_000,
      });
      // PENDING, not filled. A hash means the network accepted the bytes, not
      // that the swap happened at a price anyone would like.
      return {
        accepted: true, pending: true, txRef: submitted.hash,
        venueOrderId: submitted.hash, transactionId: submitted.transactionId,
      };
    } catch (e) {
      return { accepted: false, error: `SUBMIT_FAILED: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` };
    }
  }

  /** Resolve a broadcast transaction from its receipt. The chain decides. */
  async getOrderStatus(venueOrderId: string): Promise<AdapterOrderStatus> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: venueOrderId as Hex });
      if (!receipt) return { state: 'pending', filledQty: 0, detail: 'not yet mined' };
      if (receipt.status !== 'success') {
        this.opts.db?.prepare(
          `UPDATE execution_transactions SET state='reverted', block_number=?, block_hash=?,
           signed_payload=NULL, updated_at=? WHERE signed_tx_hash=?`,
        ).run(Number(receipt.blockNumber), receipt.blockHash, Date.now(), venueOrderId);
        return { state: 'failed', filledQty: 0, detail: `reverted in block ${receipt.blockNumber}` };
      }
      const spec = resolveLiveInstrument('ETHUSDT').spec;
      const signerAddress = (await this.opts.signer.getAddress())?.toLowerCase();
      if (!spec || !signerAddress) {
        return { state: 'unknown', filledQty: 0, detail: 'cannot decode receipt without pinned assets and signer' };
      }

      const currentBlock = await this.client.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber + 1n);
      if (confirmations < 12) {
        this.opts.db?.prepare(
          `UPDATE execution_transactions SET confirmations=?, block_number=?, block_hash=?, updated_at=?
           WHERE signed_tx_hash=?`,
        ).run(confirmations, Number(receipt.blockNumber), receipt.blockHash, Date.now(), venueOrderId);
        return {
          state: 'pending', filledQty: 0, confirmations,
          blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash,
          detail: `confirmed in block ${receipt.blockNumber}; ${confirmations}/12 confirmations`,
        };
      }

      // Transfer(address,address,uint256) — take what actually landed in our
      // wallet rather than trusting the quote's expected buyAmount.
      const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const assets = new Map([
        [spec.quote.address.toLowerCase(), spec.quote],
        [spec.base.address.toLowerCase(), spec.base],
      ]);
      const deltas: { asset: string; qtyDelta: number; logIndex: number }[] = [];
      for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSFER || log.topics.length < 3) continue;
        const token = assets.get(log.address.toLowerCase());
        if (!token) continue;
        const from = `0x${log.topics[1]!.slice(26)}`.toLowerCase();
        const to = `0x${log.topics[2]!.slice(26)}`.toLowerCase();
        let direction = 0;
        if (to === signerAddress) direction += 1;
        if (from === signerAddress) direction -= 1;
        if (direction === 0) continue;
        deltas.push({
          asset: token.symbol,
          qtyDelta: direction * Number(formatUnits(BigInt(log.data), token.decimals)),
          logIndex: Number(log.logIndex ?? deltas.length),
        });
      }

      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
      deltas.push({ asset: 'ETH', qtyDelta: -Number(formatUnits(gasCost, 18)), logIndex: -1 });
      const baseDelta = deltas.filter((d) => d.asset === spec.base.symbol).reduce((s, d) => s + d.qtyDelta, 0);
      const quoteDelta = deltas.filter((d) => d.asset === spec.quote.symbol).reduce((s, d) => s + d.qtyDelta, 0);
      if (Math.abs(baseDelta) <= 0 || Math.abs(quoteDelta) <= 0) {
        this.opts.db?.prepare(
          `UPDATE execution_transactions SET state='unknown', error=?, confirmations=?, block_number=?,
           block_hash=?, updated_at=? WHERE signed_tx_hash=?`,
        ).run('successful receipt has no complete USDG/WETH transfer pair', confirmations,
          Number(receipt.blockNumber), receipt.blockHash, Date.now(), venueOrderId);
        return { state: 'unknown', filledQty: 0, detail: 'successful receipt has no complete USDG/WETH transfer pair' };
      }
      const executedPrice = Math.abs(quoteDelta / baseDelta);
      this.opts.db?.prepare(
        `UPDATE execution_transactions SET state='confirmed', confirmations=?, block_number=?, block_hash=?,
         signed_payload=NULL, updated_at=? WHERE signed_tx_hash=?`,
      ).run(confirmations, Number(receipt.blockNumber), receipt.blockHash, Date.now(), venueOrderId);
      return {
        state: 'filled',
        filledQty: Math.abs(baseDelta),
        executedPrice,
        feeUsd: 0,
        txRef: venueOrderId,
        confirmations,
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
        gasUsedWei: gasCost.toString(),
        assetDeltas: deltas,
        detail: `final in block ${receipt.blockNumber} with ${confirmations} confirmations, gas ${receipt.gasUsed}`,
      };
    } catch (e) {
      // A receipt that cannot be read is UNKNOWN, never "failed" — the
      // difference decides whether the reconciler retries or writes off.
      const known = this.opts.db?.prepare(
        `SELECT state, created_at FROM execution_transactions WHERE signed_tx_hash=?`,
      ).get(venueOrderId) as { state: string; created_at: number } | undefined;
      if (known && ['signed', 'broadcast'].includes(known.state) && Date.now() - known.created_at <= 15 * 60_000) {
        return { state: 'pending', filledQty: 0, detail: 'broadcast transaction is not mined yet' };
      }
      return { state: 'unknown', filledQty: 0, detail: `receipt unavailable: ${String(e).slice(0, 120)}` };
    }
  }

  async recoverTransactions(): Promise<{ recovered: number; unresolved: number }> {
    return this.coordinator?.recover() ?? { recovered: 0, unresolved: 0 };
  }

  async getFundingTransfers(txHash: string, walletAddress: string): Promise<FundingTransfer[]> {
    const hash = txHash as Hex;
    const [tx, receipt] = await Promise.all([
      this.client.getTransaction({ hash }),
      this.client.getTransactionReceipt({ hash }),
    ]);
    if (receipt.status !== 'success') throw new Error('funding transaction reverted');
    const wallet = walletAddress.toLowerCase();
    const spec = resolveLiveInstrument('ETHUSDT').spec;
    if (!spec) throw new Error('core token mapping unavailable');
    const assets = new Map([
      [spec.quote.address.toLowerCase(), spec.quote],
      [spec.base.address.toLowerCase(), spec.base],
    ]);
    const transfers: FundingTransfer[] = [];
    if (tx.to?.toLowerCase() === wallet && tx.value > 0n) {
      transfers.push({ asset: 'ETH', qty: Number(formatUnits(tx.value, 18)), txRef: txHash, logIndex: -1 });
    }
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    for (const log of receipt.logs) {
      if (log.topics[0] !== TRANSFER || log.topics.length < 3) continue;
      const to = `0x${log.topics[2]!.slice(26)}`.toLowerCase();
      if (to !== wallet) continue;
      const token = assets.get(log.address.toLowerCase());
      if (!token) continue;
      transfers.push({
        asset: token.symbol,
        qty: Number(formatUnits(BigInt(log.data), token.decimals)),
        txRef: txHash,
        logIndex: Number(log.logIndex ?? transfers.length),
      });
    }

    // Privy funding can be delivered by a guarded contract call rather than a
    // top-level native transfer. In that case the receipt proves the parent
    // transaction succeeded but contains no native-transfer log. Require an
    // indexed call trace, then independently prove its value against the
    // wallet's archive balance delta at the exact block.
    if (!transfers.some((transfer) => transfer.asset === 'ETH')) {
      const traceApi = process.env.ROBINHOOD_TRACE_API_URL?.replace(/\/$/, '');
      if (traceApi) {
        const response = await this.fetch(
          `${traceApi}/internal-txs?page=1&pageSize=50&transactionHash=${encodeURIComponent(txHash)}`,
          { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } },
        );
        if (!response.ok) throw new Error(`trace indexer rejected funding proof (${response.status})`);
        const indexed = parseIndexedEthFunding(await response.json(), txHash, walletAddress);
        if (indexed.length > 0) {
          const blockNumber = indexed[0]!.blockNumber;
          if (indexed.some((entry) => entry.blockNumber !== blockNumber) || tx.blockNumber !== blockNumber) {
            throw new Error('trace indexer block does not match the funding transaction');
          }
          const address = getAddress(walletAddress) as Address;
          const [before, after] = await Promise.all([
            this.client.getBalance({ address, blockNumber: blockNumber - 1n }),
            this.client.getBalance({ address, blockNumber }),
          ]);
          const indexedWei = indexed.reduce((sum, entry) => sum + entry.valueWei, 0n);
          if (after - before < indexedWei) {
            throw new Error('archive balance delta does not prove the indexed ETH funding amount');
          }
          transfers.push(...indexed.map(({ blockNumber: _block, valueWei: _wei, ...entry }) => entry));
        }
      }
    }
    return transfers;
  }

  async getBalances(walletAddress?: string): Promise<AdapterBalance[]> {
    const address = walletAddress ?? await this.opts.signer.getAddress();
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
  async reconcile(walletAddress?: string): Promise<ReconciliationResult> {
    try {
      const balances = await this.getBalances(walletAddress);
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
