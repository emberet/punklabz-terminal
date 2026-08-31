import type { Candle, Interval } from '@punklabz/shared';
import { bollinger, rsi } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from './strategy.js';

export interface MeanReversionConfig {
  symbols: string[];
  interval: Interval;
  rsiPeriod: number;
  rsiOversold: number;
  rsiExit: number;
  bbPeriod: number;
  bbMult: number;
  positionSizePct: number;
  stopLossPct: number;
  cooldownMinutes: number;
}

export const MEAN_REVERSION_DEFAULTS: MeanReversionConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  interval: '5m',
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiExit: 50,
  bbPeriod: 20,
  bbMult: 2,
  positionSizePct: 15,
  stopLossPct: 2.5,
  cooldownMinutes: 15,
};

/** Mean Reversion: buys RSI<30 + below lower Bollinger, exits at RSI>50 or stop. */
export class MeanReversionStrategy implements Strategy {
  readonly type = 'mean_reversion';
  // A DEFAULT PARAMETER ONLY FIRES ON `undefined`.
  //
  // Every house bot stores config_json = '{}', and `{}` is a real value, so it
  // REPLACED the defaults instead of falling back to them. cfg.interval became
  // undefined, the first line of onCandle compared it to the candle's interval,
  // and the strategy returned no intents — silently, with no error, forever.
  // Five of the seven house machines had never placed a single order.
  //
  // Merging rather than defaulting makes a partial config mean what everyone
  // reading the call site assumed it meant.
  private readonly cfg: MeanReversionConfig;
  constructor(cfg: Partial<MeanReversionConfig> = {}) {
    this.cfg = { ...MEAN_REVERSION_DEFAULTS, ...cfg };
  }

  subscriptions() {
    return { symbols: this.cfg.symbols, interval: this.cfg.interval };
  }

  onCandle(ctx: StrategyContext, candle: Candle): Intent[] {
    const { cfg } = this;
    if (candle.interval !== cfg.interval || !cfg.symbols.includes(candle.symbol)) return [];
    const closes = ctx.history(candle.symbol).map((c) => c.c);
    const r = rsi(closes, cfg.rsiPeriod);
    const bb = bollinger(closes, cfg.bbPeriod, cfg.bbMult);
    if (r === null || bb === null) return [];

    const pos = ctx.positions.find((p) => p.symbol === candle.symbol);
    if (pos) {
      if (candle.c <= pos.avgEntry * (1 - cfg.stopLossPct / 100)) {
        return [{ action: 'sell', symbol: candle.symbol, reason: `stop -${cfg.stopLossPct}%` }];
      }
      if (r >= cfg.rsiExit) {
        return [{ action: 'sell', symbol: candle.symbol, reason: `rsi ${r.toFixed(0)} >= ${cfg.rsiExit}` }];
      }
      return [];
    }

    if (ctx.minutesSinceLastTrade(candle.symbol) < cfg.cooldownMinutes) return [];
    if (r < cfg.rsiOversold && candle.c < bb.lower) {
      const notional = (ctx.cashUsd * cfg.positionSizePct) / 100;
      if (notional >= 10) {
        return [{
          action: 'buy',
          symbol: candle.symbol,
          notionalUsd: notional,
          reason: `rsi ${r.toFixed(0)} + below lower BB`,
        }];
      }
    }
    return [];
  }
}
