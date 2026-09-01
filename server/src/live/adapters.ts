import type { Instrument, SwapIntent, VenueHealth } from '@punklabz/shared';
import type { TradingSigner } from './signing/signer.js';
import type { DB } from '../db/db.js';
import { ROBINHOOD_VENUE } from './instruments.js';
import { ZeroXRobinhoodAdapter } from './adapters/zeroXRobinhood.js';

// The venue boundary. ShadowAdapter is the only "executing" adapter in this
// build: it produces theoretical fills against real marks and never submits
// anything anywhere. Real venue adapters are typed stubs that report health
// and refuse orders — wiring them is a deliberate operator/config step with
// keys that this codebase never sees.

export interface AdapterQuote {
  instrumentId: string;
  price: number;
  ts: number;
}

export interface AdapterOrderResult {
  accepted: boolean;
  /** terminal fill price, only when the venue settled synchronously */
  executedPrice?: number;
  feeUsd?: number;
  txRef?: string;
  /** venue-side id for later status polling */
  venueOrderId?: string;
  /** true when the order is live at the venue but not yet resolved */
  pending?: boolean;
  error?: string;
  transactionId?: number;
}

export interface AdapterBalance {
  asset: string;
  qty: number;
  contractAddress?: string;
  decimals?: number;
  rawQty?: string;
}

export interface AdapterPosition {
  instrumentId: string;
  qty: number;
  avgEntry: number;
}

export interface AdapterOrderStatus {
  state: 'pending' | 'open' | 'partial' | 'filled' | 'cancelled' | 'failed' | 'unknown';
  filledQty: number;
  executedPrice?: number;
  feeUsd?: number;
  detail: string;
  txRef?: string;
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  gasUsedWei?: string;
  gasUsd?: number;
  assetDeltas?: {
    asset: string; qtyDelta: number; logIndex: number;
    contractAddress?: string; decimals?: number; rawDelta?: string;
  }[];
}

export interface FundingTransfer {
  asset: string;
  qty: number;
  txRef: string;
  logIndex: number;
  contractAddress?: string;
  decimals?: number;
  rawQty?: string;
}

export interface ReconciliationResult {
  ok: boolean;
  balances: AdapterBalance[];
  positions: AdapterPosition[];
  detail: string;
}

export interface ConservativeNavResult {
  ok: boolean;
  totalUsd: number;
  settlementUsd: number;
  holdings: { asset: string; qty: number; liquidationUsd: number }[];
  blockers: string[];
}

export interface ExecutionAdapter {
  readonly venue: string;
  health(): Promise<VenueHealth>;
  getQuote(inst: Instrument): Promise<AdapterQuote | null>;
  /** firm, taker-bound quote used for launch/reference checks; never signed */
  getExecutableQuote?(inst: Instrument): Promise<AdapterQuote | null>;
  /** conservative executable liquidation price for an exact base-asset quantity */
  getExecutableSellQuote?(inst: Instrument, quantity: number): Promise<AdapterQuote | null>;
  /**
   * Submit an order. `minReceive` is slippage protection that a real adapter
   * MUST encode into the transaction itself before signing — checking slippage
   * after a chain transaction has executed is measurement, not protection.
   */
  placeOrder(
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
      /** exact base quantity for a receipt-derived close; only valid for sells */
      exactSellQuantity?: number;
    },
  ): Promise<AdapterOrderResult>;
  /** poll a submitted order until it resolves */
  getOrderStatus?(venueOrderId: string): Promise<AdapterOrderStatus>;
  cancelOrder?(venueOrderId: string): Promise<void>;
  getBalances?(walletAddress?: string): Promise<AdapterBalance[]>;
  getPositions?(): Promise<AdapterPosition[]>;
  /** authoritative venue state for the reconciler */
  reconcile?(walletAddress?: string): Promise<ReconciliationResult>;
  recoverTransactions?(): Promise<{ recovered: number; unresolved: number }>;
  getFundingTransfers?(txHash: string, walletAddress: string): Promise<FundingTransfer[]>;
  verifyCoreAssets?(): Promise<{ ok: boolean; failures: string[] }>;
  estimateGasReserveEth?(transactionCount: number): Promise<number>;
  placeSwapIntent?(intent: SwapIntent, opts: {
    orderId: number;
    maxSlippageBps: number;
    safetyBufferBps: number;
    ethUsd: number;
  }): Promise<AdapterOrderResult>;
  getConservativeNav?(walletAddress: string): Promise<ConservativeNavResult>;
}

export class NotConfiguredAdapter implements ExecutionAdapter {
  constructor(
    readonly venue: string,
    private note: string,
  ) {}

  async health(): Promise<VenueHealth> {
    return {
      venue: this.venue,
      status: 'offline',
      latencyMs: null,
      errorRate: 0,
      lastOkAt: null,
      note: this.note,
    };
  }

  async getQuote(): Promise<AdapterQuote | null> {
    return null;
  }

  async placeOrder(): Promise<AdapterOrderResult> {
    return { accepted: false, error: `${this.venue}: NOT_CONFIGURED — no signer/credentials in this build` };
  }

  async getBalances(): Promise<AdapterBalance[]> {
    return [];
  }

  async getPositions(): Promise<AdapterPosition[]> {
    return [];
  }

  async reconcile(): Promise<ReconciliationResult> {
    return { ok: false, balances: [], positions: [], detail: `${this.venue}: not configured` };
  }
}

/**
 * Shadow execution: real market data, real order flow, ZERO submission.
 * Fills are theoretical (mark ± modeled slippage + fee) and are labeled so.
 */
export class ShadowAdapter implements ExecutionAdapter {
  readonly venue = 'shadow';

  constructor(private markOf: (symbol: string) => number | undefined) {}

  async health(): Promise<VenueHealth> {
    const mark = this.markOf('BTCUSDT');
    return {
      venue: this.venue,
      status: mark !== undefined ? 'online' : 'degraded',
      latencyMs: 0,
      errorRate: 0,
      lastOkAt: Date.now(),
      note: 'theoretical fills against live marks — nothing is submitted',
    };
  }

  async getQuote(inst: Instrument): Promise<AdapterQuote | null> {
    const mark = this.markOf(inst.symbol);
    if (mark === undefined) return null;
    return { instrumentId: inst.id, price: mark, ts: Date.now() };
  }

  async getBalances(): Promise<AdapterBalance[]> {
    return []; // shadow holds no custody — its book is the ledger
  }

  async reconcile(): Promise<ReconciliationResult> {
    return {
      ok: true,
      balances: [],
      positions: [],
      detail: 'shadow book is authoritative by construction — nothing is custodied',
    };
  }

  async placeOrder(inst: Instrument, side: 'buy' | 'sell', notionalUsd: number): Promise<AdapterOrderResult> {
    const mark = this.markOf(inst.symbol);
    if (mark === undefined) return { accepted: false, error: 'no live mark for instrument' };
    const slip = 10 / 10_000; // conservative 10bps modeled slippage
    const executedPrice = side === 'buy' ? mark * (1 + slip) : mark * (1 - slip);
    return {
      accepted: true,
      executedPrice,
      feeUsd: (notionalUsd * 10) / 10_000, // 10bps modeled fee
      txRef: `shadow:${Date.now().toString(36)}`,
    };
  }
}

export function buildAdapters(
  markOf: (s: string) => number | undefined,
  signer?: TradingSigner,
  db?: DB,
): Map<string, ExecutionAdapter> {
  const adapters = new Map<string, ExecutionAdapter>();
  const shadow = new ShadowAdapter(markOf);
  adapters.set('shadow', shadow);
  adapters.set('paper', shadow); // paper-venue instruments execute via shadow fills

  // ROBINHOOD CHAIN — the one venue that can move real funds.
  //
  // Registered only when both an API key and a signer exist. Without either it
  // stays a NotConfiguredAdapter that refuses orders, which is what keeps the
  // execution_adapter preflight check honest: the router finds *an* adapter for
  // this venue either way, so it never falls through to shadow, and a missing
  // credential produces a refusal rather than a silent simulation.
  const zeroXKey = process.env.ZEROX_API_KEY ?? '';
  if (zeroXKey && signer) {
    adapters.set(ROBINHOOD_VENUE, new ZeroXRobinhoodAdapter({
      apiKey: zeroXKey,
      signer,
      db,
    }));
  } else {
    adapters.set(ROBINHOOD_VENUE, new NotConfiguredAdapter(
      ROBINHOOD_VENUE,
      !zeroXKey ? 'ZEROX_API_KEY not set' : 'no trading signer configured',
    ));
  }

  for (const [venue, note] of [
    ['evm:base', 'EVM adapter stub — superseded by Robinhood Chain as the home network'],
    ['solana', 'Solana adapter stub — aggregator + signer not configured'],
    ['broker', 'Broker adapter stub — no brokerage account connected'],
    ['polymarket', 'Polymarket adapter stub — CLOB credentials not configured'],
  ] as const) {
    adapters.set(venue, new NotConfiguredAdapter(venue, note));
  }
  return adapters;
}
