import type { Candle } from '@punklabz/shared';

// All functions take candles oldest-first and return the latest value,
// or null when there isn't enough history.

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function stddev(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export function bollinger(
  closes: number[],
  period: number,
  mult = 2,
): { upper: number; lower: number; width: number } | null {
  const mid = sma(closes, period);
  const sd = stddev(closes, period);
  if (mid === null || sd === null) return null;
  return { upper: mid + mult * sd, lower: mid - mult * sd, width: (2 * mult * sd) / mid };
}

export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  return sma(trs, period);
}

export function priceChangePct(closes: number[], lookbackBars: number): number | null {
  if (closes.length < lookbackBars + 1) return null;
  const prev = closes[closes.length - 1 - lookbackBars];
  if (prev === 0) return null;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

/** true when fast crossed above slow on the latest bar */
export function crossAbove(fast: number[], slow: number[]): boolean {
  const n = fast.length;
  if (n < 2 || slow.length < 2) return false;
  return fast[n - 2] <= slow[slow.length - 2] && fast[n - 1] > slow[slow.length - 1];
}

export function crossBelow(fast: number[], slow: number[]): boolean {
  const n = fast.length;
  if (n < 2 || slow.length < 2) return false;
  return fast[n - 2] >= slow[slow.length - 2] && fast[n - 1] < slow[slow.length - 1];
}

/** EMA series (one value per input bar from index period-1 on). */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
