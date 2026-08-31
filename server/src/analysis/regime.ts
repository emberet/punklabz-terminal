import type { Candle } from '@punklabz/shared';
import { atr, ema } from '../engine/indicators.js';

// Market regime classifier — deterministic, from recent 1m candles.
// TRENDING UP/DOWN · RANGING · HIGH/LOW VOLATILITY · BREAKOUT.

export type Regime =
  | 'TRENDING UP'
  | 'TRENDING DOWN'
  | 'RANGING'
  | 'HIGH VOLATILITY'
  | 'LOW VOLATILITY'
  | 'BREAKOUT';

export interface RegimeReading {
  regime: Regime;
  atrPct: number;
  emaSlopePct: number;
}

/** Which machine classes are built for each regime (design affinity, not a prediction). */
export const REGIME_AFFINITY: Record<Regime, string[]> = {
  'TRENDING UP': ['momentum'],
  'TRENDING DOWN': ['mean_reversion'],
  RANGING: ['grid', 'mean_reversion'],
  'HIGH VOLATILITY': ['pump_sniper', 'herd_sentiment'],
  'LOW VOLATILITY': ['grid'],
  BREAKOUT: ['momentum', 'herd_sentiment'],
};

export function classifyRegime(m1: Candle[]): RegimeReading | null {
  if (m1.length < 120) return null;
  const closes = m1.map((c) => c.c);
  const price = closes[closes.length - 1];

  const a = atr(m1.slice(-60), 14);
  const atrPct = a !== null && price > 0 ? (a / price) * 100 : 0;

  const emaNow = ema(closes, 20);
  const emaPast = ema(closes.slice(0, -30), 20);
  const emaSlopePct = emaNow !== null && emaPast !== null && price > 0
    ? ((emaNow - emaPast) / price) * 100
    : 0;

  // breakout: last close beyond the prior 2h range
  const prior = m1.slice(-130, -10);
  const rangeHigh = Math.max(...prior.map((c) => c.h));
  const rangeLow = Math.min(...prior.map((c) => c.l));
  const broke = price > rangeHigh || price < rangeLow;

  let regime: Regime;
  if (broke && atrPct > 0.05) regime = 'BREAKOUT';
  else if (atrPct > 0.12) regime = 'HIGH VOLATILITY';
  else if (Math.abs(emaSlopePct) > 0.25) regime = emaSlopePct > 0 ? 'TRENDING UP' : 'TRENDING DOWN';
  else if (atrPct < 0.03) regime = 'LOW VOLATILITY';
  else regime = 'RANGING';

  return { regime, atrPct: Math.round(atrPct * 1000) / 1000, emaSlopePct: Math.round(emaSlopePct * 1000) / 1000 };
}
