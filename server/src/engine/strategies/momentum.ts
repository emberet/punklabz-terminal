import type { Candle, Interval } from '@punklabz/shared';
import { crossAbove, crossBelow, emaSeries, sma } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from './strategy.js';

export interface MomentumConfig {
  symbols: string[];
  interval: Interval;
  fastEma: number;
  slowEma: number;
  volumeMultiple: number; // volume must exceed volumeMultiple × volumeSma(20)
  positionSizePct: number;
  stopLossPct: number;
  cooldownMinutes: number;
}

export const MOMENTUM_DEFAULTS: MomentumConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  interval: '15m',
  fastEma: 9,
  slowEma: 21,
  volumeMultiple: 1.5,
  positionSizePct: 20,
  stopLossPct: 3,
  cooldownMinutes: 30,
};

/** Momentum Runner: EMA crossover + volume confirmation, rides trend, exits on cross-down or stop. */
export class MomentumStrategy implements Strategy {
  readonly type = 'momentum';
  constructor(private cfg: MomentumConfig = MOMENTUM_DEFAULTS) {}

  subscriptions() {
    return { symbols: this.cfg.symbols, interval: this.cfg.interval };
  }

  onCandle(ctx: StrategyContext, candle: Candle): Intent[] {
    const { cfg } = this;
    if (candle.interval !== cfg.interval || !cfg.symbols.includes(candle.symbol)) return [];
    const hist = ctx.history(candle.symbol);
    const closes = hist.map((c) => c.c);
    const fast = emaSeries(closes, cfg.fastEma);
    const slow = emaSeries(closes, cfg.slowEma);
    if (fast.length < 2 || slow.length < 2) return [];

    const pos = ctx.positions.find((p) => p.symbol === candle.symbol);
    const intents: Intent[] = [];

    if (pos) {
      const stopHit = candle.c <= pos.avgEntry * (1 - cfg.stopLossPct / 100);
      if (stopHit) {
        intents.push({ action: 'sell', symbol: candle.symbol, reason: `stop -${cfg.stopLossPct}%` });
      } else if (crossBelow(fast, slow)) {
        intents.push({ action: 'sell', symbol: candle.symbol, reason: 'ema cross down' });
      }
      return intents;
    }

    if (ctx.minutesSinceLastTrade(candle.symbol) < cfg.cooldownMinutes) return [];
    const vols = hist.map((c) => c.v);
    const volAvg = sma(vols.slice(0, -1), 20);
    const volumeOk = volAvg !== null && candle.v > cfg.volumeMultiple * volAvg;
    if (crossAbove(fast, slow) && volumeOk) {
      const notional = (ctx.cashUsd * cfg.positionSizePct) / 100;
      if (notional >= 10) {
        intents.push({
          action: 'buy',
          symbol: candle.symbol,
          notionalUsd: notional,
          reason: `ema ${cfg.fastEma}/${cfg.slowEma} cross up, vol ${cfg.volumeMultiple}x`,
        });
      }
    }
    return intents;
  }
}
