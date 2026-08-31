import type { Instrument, VenueHealth } from '@punklabz/shared';

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
}

export interface AdapterBalance {
  asset: string;
  qty: number;
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
}

export interface ReconciliationResult {
  ok: boolean;
  balances: AdapterBalance[];
  positions: AdapterPosition[];
  detail: string;
}

export interface ExecutionAdapter {
  readonly venue: string;
  health(): Promise<VenueHealth>;
  getQuote(inst: Instrument): Promise<AdapterQuote | null>;
  /**
   * Submit an order. `minReceive` is slippage protection that a real adapter
   * MUST encode into the transaction itself before signing — checking slippage
   * after a chain transaction has executed is measurement, not protection.
   */
  placeOrder(
    inst: Instrument,
    side: 'buy' | 'sell',
    notionalUsd: number,
    opts?: { minReceive?: number; intentId?: string },
  ): Promise<AdapterOrderResult>;
  /** poll a submitted order until it resolves */
  getOrderStatus?(venueOrderId: string): Promise<AdapterOrderStatus>;
  cancelOrder?(venueOrderId: string): Promise<void>;
  getBalances?(): Promise<AdapterBalance[]>;
  getPositions?(): Promise<AdapterPosition[]>;
  /** authoritative venue state for the reconciler */
  reconcile?(): Promise<ReconciliationResult>;
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

export function buildAdapters(markOf: (s: string) => number | undefined): Map<string, ExecutionAdapter> {
  const adapters = new Map<string, ExecutionAdapter>();
  const shadow = new ShadowAdapter(markOf);
  adapters.set('shadow', shadow);
  adapters.set('paper', shadow); // paper-venue instruments execute via shadow fills
  for (const [venue, note] of [
    ['evm:base', 'EVM adapter stub — 0x routing + signer are a later, operator-configured sprint'],
    ['solana', 'Solana adapter stub — aggregator + signer not configured'],
    ['broker', 'Broker adapter stub — no brokerage account connected'],
    ['polymarket', 'Polymarket adapter stub — CLOB credentials not configured'],
  ] as const) {
    adapters.set(venue, new NotConfiguredAdapter(venue, note));
  }
  return adapters;
}
