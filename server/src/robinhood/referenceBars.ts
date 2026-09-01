import type { ReferenceQuote } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { formatMultiplier, normalizeStockTokenPrice, parseMultiplier } from './multiplier.js';

/** Store a multiplier-adjusted one-minute observation without using it as ledger truth. */
export function recordReferenceBar(db: DB, quote: ReferenceQuote, multiplier: bigint): void {
  const minute = Math.floor(quote.generatedAt / 60_000) * 60_000;
  const adjusted = normalizeStockTokenPrice(quote.mid, multiplier);
  const value = adjusted.toFixed(12);
  db.prepare(
    `INSERT INTO rh_reference_price_bars
       (symbol, minute_ts, open, high, low, close, multiplier, sample_count, last_generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(symbol, minute_ts) DO UPDATE SET
       high=CASE WHEN CAST(excluded.high AS REAL)>CAST(high AS REAL) THEN excluded.high ELSE high END,
       low=CASE WHEN CAST(excluded.low AS REAL)<CAST(low AS REAL) THEN excluded.low ELSE low END,
       close=excluded.close, multiplier=excluded.multiplier,
       sample_count=sample_count+1, last_generated_at=excluded.last_generated_at`,
  ).run(quote.symbol, minute, value, value, value, value, formatMultiplier(multiplier), quote.generatedAt);
}

export function recordReferenceBarFromString(db: DB, quote: ReferenceQuote, multiplier: string): void {
  recordReferenceBar(db, quote, parseMultiplier(multiplier));
}

