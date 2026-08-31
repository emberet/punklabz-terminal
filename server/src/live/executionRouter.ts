import type { Instrument } from '@punklabz/shared';
import type { ExecutionAdapter, AdapterOrderResult } from './adapters.js';
import { findInstrument } from './instruments.js';

// THE ROUTER. Strategies and agents never name a venue, never call 0x, never
// call a broker. They emit a standardized intent; this service decides where
// and how it executes. Swapping venues, adding chains, or changing routing
// policy touches only this file.

export interface RouteRequest {
  instrumentId: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  maxSlippageBps: number;
}

export interface RouteDecision {
  venue: string;
  adapter: ExecutionAdapter | null;
  instrument: Instrument | null;
  routable: boolean;
  reason: string;
}

export class ExecutionRouter {
  constructor(private adapters: Map<string, ExecutionAdapter>) {}

  /** pick a destination for an intent — or explain why there isn't one */
  route(req: RouteRequest): RouteDecision {
    const instrument = findInstrument(req.instrumentId);
    if (!instrument) {
      return { venue: 'none', adapter: null, instrument: null, routable: false, reason: 'unknown instrument' };
    }
    if (!instrument.tradable) {
      return {
        venue: instrument.venue,
        adapter: null,
        instrument,
        routable: false,
        reason: instrument.note ?? 'instrument not tradable in this build',
      };
    }
    if (req.notionalUsd < instrument.minNotionalUsd) {
      return {
        venue: instrument.venue,
        adapter: null,
        instrument,
        routable: false,
        reason: `below venue minimum $${instrument.minNotionalUsd}`,
      };
    }
    const adapter = this.adapters.get(instrument.venue) ?? this.adapters.get('shadow') ?? null;
    if (!adapter) {
      return { venue: instrument.venue, adapter: null, instrument, routable: false, reason: 'no adapter for venue' };
    }
    return {
      venue: adapter.venue,
      adapter,
      instrument,
      routable: true,
      reason: `routed to ${adapter.venue}`,
    };
  }

  /** execute a routed intent; enforces the slippage ceiling after the fill */
  async execute(
    decision: RouteDecision,
    req: RouteRequest,
    expectedPrice: number,
  ): Promise<AdapterOrderResult & { slippageBps: number }> {
    if (!decision.routable || !decision.adapter || !decision.instrument) {
      return { accepted: false, error: decision.reason, slippageBps: 0 };
    }
    const result = await decision.adapter.placeOrder(decision.instrument, req.side, req.notionalUsd);
    if (!result.accepted || result.executedPrice === undefined) {
      return { ...result, slippageBps: 0 };
    }
    const slippageBps =
      expectedPrice > 0
        ? ((result.executedPrice - expectedPrice) / expectedPrice) * 10_000 * (req.side === 'buy' ? 1 : -1)
        : 0;
    if (slippageBps > req.maxSlippageBps) {
      return {
        accepted: false,
        error: `slippage ${slippageBps.toFixed(1)}bps exceeded ceiling ${req.maxSlippageBps}bps`,
        slippageBps,
      };
    }
    return { ...result, slippageBps };
  }
}
