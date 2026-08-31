import type { ReferenceQuote } from '@punklabz/shared';
import type { DB } from '../db/db.js';

// REFERENCE PRICE ≠ EXECUTABLE PRICE.
//
// This module returns what the underlying is worth according to Robinhood. It
// is NOT a price anything can be filled at, and two properties make that
// explicit at the type level and at the boundary:
//
//   - every quote carries `generatedAt` from the API payload and an `ageMs`
//     measured against it, never against when we fetched it
//   - a stale quote is returned with stale=true rather than withheld, so the
//     caller decides — but the dislocation path refuses stale outright
//
// The API also returns the RAW per-share underlying price. It is not
// multiplier-adjusted. Nothing here adjusts it either; that is
// normalizeStockTokenPrice()'s job, and keeping the raw value raw all the way
// to that one call site is what stops a double-adjustment.

const PRICES_URL = 'https://api.robinhood.com/rhj/prices';

/** Beyond this a reference price is not evidence of anything. */
export const DEFAULT_STALE_MS = 60_000;

interface ApiQuote {
  tokenSymbol: string;
  bid: string;
  ask: string;
  currency: string;
  isTradingHalt: boolean;
  generatedAt: string;
  dailyTradingVolume?: string;
  dailyHigh?: string;
  dailyLow?: string;
}

export interface FetchQuoteOptions {
  staleMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function fetchReferenceQuote(
  db: DB,
  symbol: string,
  opts: FetchQuoteOptions = {},
): Promise<ReferenceQuote | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  let quote: ApiQuote | undefined;
  try {
    const res = await doFetch(`${PRICES_URL}/${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { quotes?: ApiQuote[] };
    quote = body.quotes?.[0];
  } catch {
    return null;
  }
  if (!quote) return null;

  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const generatedAt = Date.parse(quote.generatedAt);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(generatedAt)) return null;
  if (bid <= 0 || ask <= 0 || ask < bid) return null;

  db.prepare(
    `INSERT INTO rh_reference_prices
       (symbol, bid, ask, currency, is_trading_halt, daily_volume, daily_high, daily_low, generated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    quote.tokenSymbol, bid, ask, quote.currency, quote.isTradingHalt ? 1 : 0,
    quote.dailyTradingVolume ? Number(quote.dailyTradingVolume) : null,
    quote.dailyHigh ? Number(quote.dailyHigh) : null,
    quote.dailyLow ? Number(quote.dailyLow) : null,
    generatedAt, Date.now(),
  );

  return toQuote(quote.tokenSymbol, bid, ask, quote.currency, quote.isTradingHalt, generatedAt, staleMs, opts.now ?? Date.now());
}

/** Last cached quote, aged honestly. Used when the API is unreachable. */
export function lastReferenceQuote(
  db: DB,
  symbol: string,
  opts: { staleMs?: number; now?: number } = {},
): ReferenceQuote | null {
  const row = db
    .prepare(`SELECT * FROM rh_reference_prices WHERE symbol = ? ORDER BY generated_at DESC LIMIT 1`)
    .get(symbol) as any;
  if (!row) return null;
  return toQuote(
    row.symbol, row.bid, row.ask, row.currency, row.is_trading_halt === 1,
    row.generated_at, opts.staleMs ?? DEFAULT_STALE_MS, opts.now ?? Date.now(),
  );
}

function toQuote(
  symbol: string, bid: number, ask: number, currency: string,
  isTradingHalt: boolean, generatedAt: number, staleMs: number, now: number,
): ReferenceQuote {
  const ageMs = now - generatedAt;
  return {
    symbol, bid, ask,
    mid: (bid + ask) / 2,
    currency,
    isTradingHalt,
    generatedAt,
    ageMs,
    // a future-dated quote is as untrustworthy as an old one
    stale: ageMs > staleMs || ageMs < -5_000,
  };
}

export interface PriceGate {
  usable: boolean;
  reason: string;
}

/**
 * Whether a reference quote may be used to justify a trade. Deliberately
 * stricter than "we have a number".
 */
export function referencePriceGate(quote: ReferenceQuote | null): PriceGate {
  if (!quote) return { usable: false, reason: 'no reference price available' };
  if (quote.isTradingHalt) return { usable: false, reason: `${quote.symbol} underlying is halted` };
  if (quote.stale) {
    return {
      usable: false,
      reason: `reference price is ${(quote.ageMs / 1000).toFixed(0)}s old — stale`,
    };
  }
  if (quote.mid <= 0) return { usable: false, reason: 'reference mid is not positive' };
  const spreadBps = ((quote.ask - quote.bid) / quote.mid) * 10_000;
  if (spreadBps > 500) {
    return { usable: false, reason: `reference spread ${spreadBps.toFixed(0)}bps is too wide to price against` };
  }
  return { usable: true, reason: `fresh (${(quote.ageMs / 1000).toFixed(1)}s), spread ${spreadBps.toFixed(1)}bps` };
}
