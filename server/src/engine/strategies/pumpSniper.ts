import type { Intent, PumpTokenStats, Strategy, StrategyContext } from './strategy.js';

export interface PumpSniperConfig {
  entryPctOfBalance: number;   // small aggressive entries
  minUniqueBuyers60s: number;  // launch heat filter
  maxTokenAgeMs: number;       // only enter very fresh launches
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMs: number;           // hard timeout exit
  maxConcurrent: number;
}

export const PUMP_SNIPER_DEFAULTS: PumpSniperConfig = {
  entryPctOfBalance: 0.5,
  minUniqueBuyers60s: 8,
  maxTokenAgeMs: 5 * 60_000,
  takeProfitPct: 50,
  stopLossPct: 30,
  maxHoldMs: 10 * 60_000,
  maxConcurrent: 3,
};

/** Pump Sniper: tiny early entries into hot pump.fun launches, ruthless exits. */
export class PumpSniperStrategy implements Strategy {
  readonly type = 'pump_sniper';
  constructor(private cfg: PumpSniperConfig = PUMP_SNIPER_DEFAULTS) {}

  subscriptions() {
    return { symbols: [], interval: '1m' as const };
  }

  onCandle(): Intent[] {
    return [];
  }

  onPumpUpdate(ctx: StrategyContext, token: PumpTokenStats): Intent[] {
    const { cfg } = this;
    const age = ctx.now - token.launchedAt;
    const held = ctx.positions.some((p) => p.symbol === token.mint);
    if (held) return this.exitCheck(ctx, token);
    if (age > cfg.maxTokenAgeMs) return [];
    if (token.uniqueBuyers60s < cfg.minUniqueBuyers60s) return [];
    if (ctx.positions.length >= cfg.maxConcurrent) return [];
    const notional = (ctx.cashUsd * cfg.entryPctOfBalance) / 100;
    if (notional < 5) return [];
    return [{
      action: 'buy',
      symbol: token.mint,
      notionalUsd: notional,
      reason: `snipe: ${token.uniqueBuyers60s} buyers in 60s, age ${(age / 1000).toFixed(0)}s`,
    }];
  }

  private exitCheck(ctx: StrategyContext, token: PumpTokenStats): Intent[] {
    const { cfg } = this;
    const pos = ctx.positions.find((p) => p.symbol === token.mint);
    if (!pos) return [];
    const mark = ctx.mark(token.mint);
    if (mark === undefined || pos.avgEntry <= 0) return [];
    const pnlPct = ((mark - pos.avgEntry) / pos.avgEntry) * 100;
    if (pnlPct >= cfg.takeProfitPct)
      return [{ action: 'sell', symbol: token.mint, reason: `tp +${pnlPct.toFixed(0)}%` }];
    if (pnlPct <= -cfg.stopLossPct)
      return [{ action: 'sell', symbol: token.mint, reason: `sl ${pnlPct.toFixed(0)}%` }];
    return [];
  }

  /** hard timeout exits, independent of trade flow */
  onTimer(ctx: StrategyContext): Intent[] {
    const intents: Intent[] = [];
    for (const pos of ctx.positions) {
      if (ctx.now - pos.openedAt > this.cfg.maxHoldMs) {
        intents.push({ action: 'sell', symbol: pos.symbol, reason: 'max hold timeout' });
      }
    }
    return intents;
  }
}
