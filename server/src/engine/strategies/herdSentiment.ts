import type { Intent, PumpTokenStats, Strategy, StrategyContext } from './strategy.js';

export interface HerdSentimentConfig {
  entryPctOfBalance: number;
  minBuys60s: number;          // herd is moving
  minAgeMs: number;            // skip the launch chaos the sniper plays
  maxAgeMs: number;
  trailingStopPct: number;
  maxHoldMs: number;
  maxConcurrent: number;
}

export const HERD_DEFAULTS: HerdSentimentConfig = {
  entryPctOfBalance: 1,
  minBuys60s: 20,
  minAgeMs: 2 * 60_000,
  maxAgeMs: 20 * 60_000,
  trailingStopPct: 20,
  maxHoldMs: 30 * 60_000,
  maxConcurrent: 3,
};

/**
 * Herd Sentiment: waits for sustained buy pressure on tokens that survived
 * their first minutes, rides the herd with a trailing stop.
 */
export class HerdSentimentStrategy implements Strategy {
  readonly type = 'herd_sentiment';
  private highWater = new Map<string, number>(); // mint -> peak mark since entry

  constructor(private cfg: HerdSentimentConfig = HERD_DEFAULTS) {}

  subscriptions() {
    return { symbols: [], interval: '1m' as const };
  }

  onCandle(): Intent[] {
    return [];
  }

  onPumpUpdate(ctx: StrategyContext, token: PumpTokenStats): Intent[] {
    const { cfg } = this;
    const pos = ctx.positions.find((p) => p.symbol === token.mint);
    const mark = ctx.mark(token.mint);

    if (pos) {
      if (mark === undefined) return [];
      const peak = Math.max(this.highWater.get(token.mint) ?? pos.avgEntry, mark);
      this.highWater.set(token.mint, peak);
      const offPeakPct = ((peak - mark) / peak) * 100;
      if (offPeakPct >= cfg.trailingStopPct) {
        this.highWater.delete(token.mint);
        return [{ action: 'sell', symbol: token.mint, reason: `trail -${offPeakPct.toFixed(0)}% off peak` }];
      }
      return [];
    }

    const age = ctx.now - token.launchedAt;
    if (age < cfg.minAgeMs || age > cfg.maxAgeMs) return [];
    if (token.buys60s < cfg.minBuys60s) return [];
    if (ctx.positions.length >= cfg.maxConcurrent) return [];
    const notional = (ctx.cashUsd * cfg.entryPctOfBalance) / 100;
    if (notional < 5) return [];
    return [{
      action: 'buy',
      symbol: token.mint,
      notionalUsd: notional,
      reason: `herd: ${token.buys60s} buys/60s at age ${(age / 60_000).toFixed(1)}m`,
    }];
  }

  onTimer(ctx: StrategyContext): Intent[] {
    const intents: Intent[] = [];
    for (const pos of ctx.positions) {
      if (ctx.now - pos.openedAt > this.cfg.maxHoldMs) {
        this.highWater.delete(pos.symbol);
        intents.push({ action: 'sell', symbol: pos.symbol, reason: 'max hold timeout' });
      }
    }
    return intents;
  }
}
