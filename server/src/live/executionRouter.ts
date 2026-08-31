import type { Instrument } from '@punklabz/shared';
import type { ExecutionAdapter, AdapterOrderResult } from './adapters.js';
import { findInstrument } from './instruments.js';
import { revocationCache } from './delegation/revocationCache.js';

// THE ROUTER. Strategies and agents never name a venue, never call 0x, never
// call a broker. They emit a standardized intent; this service decides where
// and how it executes. Swapping venues, adding chains, or changing routing
// policy touches only this file.

export interface RouteRequest {
  instrumentId: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  maxSlippageBps: number;
  /** the mode decides which adapters are even eligible */
  mode: 'simulation' | 'shadow' | 'canary' | 'live';
  intentId?: string;
  /** present when this order spends a delegated wallet rather than the house book */
  delegation?: { grantId: number; isExit: boolean };
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

  /**
   * Pick a destination for an intent — or explain why there isn't one.
   *
   * There is deliberately NO fallback. A previous version fell back to the
   * shadow adapter when a venue was missing, which meant an order intended for
   * a real venue could be silently simulated and booked as though it had
   * happened. Modes that can move funds must reach their exact adapter or the
   * order is rejected.
   */
  route(req: RouteRequest): RouteDecision {
    const instrument = findInstrument(req.instrumentId);
    if (!instrument) {
      return { venue: 'none', adapter: null, instrument: null, routable: false, reason: 'unknown instrument' };
    }

    const realMoney = req.mode === 'canary' || req.mode === 'live';
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
    // simulation and shadow book against the shadow adapter by design;
    // canary and live must reach the instrument's own venue, exactly.
    const adapter = realMoney
      ? this.adapters.get(instrument.venue) ?? null
      : this.adapters.get(instrument.venue) ?? this.adapters.get('shadow') ?? null;

    if (!adapter) {
      return {
        venue: instrument.venue,
        adapter: null,
        instrument,
        routable: false,
        reason: `ADAPTER_UNAVAILABLE for ${instrument.venue} — refusing to route (no shadow fallback in ${req.mode} mode)`,
      };
    }
    if (realMoney && (adapter.venue === 'shadow' || adapter.venue === 'paper')) {
      return {
        venue: adapter.venue,
        adapter: null,
        instrument,
        routable: false,
        reason: `refusing to route ${req.mode} order to a simulated venue`,
      };
    }
    return {
      venue: adapter.venue,
      adapter,
      instrument,
      routable: true,
      reason: `routed to ${adapter.venue}`,
    };
  }

  /**
   * Execute a routed intent.
   *
   * `minReceive` is computed here and handed to the adapter, which must encode
   * it into the transaction BEFORE signing. Post-fill slippage below is
   * measurement for the ledger, not protection — on-chain, a check after the
   * transaction lands is too late to prevent anything.
   */
  async execute(
    decision: RouteDecision,
    req: RouteRequest,
    expectedPrice: number,
  ): Promise<AdapterOrderResult & { slippageBps: number; minReceive: number }> {
    if (!decision.routable || !decision.adapter || !decision.instrument) {
      return { accepted: false, error: decision.reason, slippageBps: 0, minReceive: 0 };
    }

    // THE LAST GATE BEFORE SOMEONE ELSE'S MONEY MOVES.
    //
    // Risk approval and venue submission are not the same instant. An owner who
    // revokes in that window has revoked, and this is the only place left to
    // honour it — synchronous, in-process, no DB round trip, no await. Exits
    // pass: revocation must never trap someone in a position.
    if (req.delegation && !req.delegation.isExit && revocationCache.isRevoked(req.delegation.grantId)) {
      return {
        accepted: false,
        error: `DELEGATION_REVOKED: grant ${req.delegation.grantId} is not authorised to spend — order not submitted`,
        slippageBps: 0,
        minReceive: 0,
      };
    }

    const tolerance = req.maxSlippageBps / 10_000;
    const minReceive =
      req.side === 'buy'
        ? (req.notionalUsd / (expectedPrice * (1 + tolerance)))  // min base units received
        : req.notionalUsd * (1 - tolerance);                     // min quote received
    const result = await decision.adapter.placeOrder(decision.instrument, req.side, req.notionalUsd, {
      minReceive,
      intentId: req.intentId,
    });
    if (!result.accepted) {
      return { ...result, slippageBps: 0, minReceive };
    }
    // an order that is live at the venue but unresolved is not a fill
    if (result.pending || result.executedPrice === undefined) {
      return { ...result, slippageBps: 0, minReceive };
    }
    const slippageBps =
      expectedPrice > 0
        ? ((result.executedPrice - expectedPrice) / expectedPrice) * 10_000 * (req.side === 'buy' ? 1 : -1)
        : 0;
    if (slippageBps > req.maxSlippageBps) {
      // For a simulated venue this is a rejection. For a real one the fill has
      // already happened — the ceiling was supposed to be enforced by
      // minReceive inside the transaction. Record it loudly either way.
      return {
        ...result,
        accepted: decision.adapter.venue !== 'shadow',
        error: `slippage ${slippageBps.toFixed(1)}bps exceeded ceiling ${req.maxSlippageBps}bps`,
        slippageBps,
        minReceive,
      };
    }
    return { ...result, slippageBps, minReceive };
  }
}
