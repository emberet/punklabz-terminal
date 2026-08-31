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
  executedPrice?: number;
  feeUsd?: number;
  txRef?: string;
  error?: string;
}

export interface ExecutionAdapter {
  readonly venue: string;
  health(): Promise<VenueHealth>;
  getQuote(inst: Instrument): Promise<AdapterQuote | null>;
  placeOrder(inst: Instrument, side: 'buy' | 'sell', notionalUsd: number): Promise<AdapterOrderResult>;
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
