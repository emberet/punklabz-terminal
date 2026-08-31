import { ROBINHOOD_MAINNET_CHAIN_ID } from '@punklabz/shared';
import type { DB } from '../db/db.js';

// THE MULTIPLIER. The most dangerous number in this integration.
//
// Stock Token balances do not rebase. When a corporate action happens, the
// token's `uiMultiplier()` changes instead, and the relationship is:
//
//     underlying shares = raw token amount × uiMultiplier / 1e18
//
// which means:
//
//     token fair value = underlying price per share × uiMultiplier
//
// The reference price API returns the RAW UNDERLYING per-share price and says
// so explicitly: "Returns raw underlying-equity prices (not multiplier-
// adjusted)". So the two numbers are NOT comparable until the multiplier is
// applied.
//
// This is not hypothetical. As of 2026-08-31, CRWD carries a multiplier of
// exactly 4.0 after a 4:1 split — verified both in the API and by calling
// uiMultiplier() on 0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931. Its reference
// price is ~$218. Its token is therefore worth ~$872. A dislocation engine
// that compares $218 against $872 does not see a bug; it sees the largest
// arbitrage in the history of the network, and it sizes into it.
//
// Seven other live assets (AAPL, ORCL, COST, SGOV, MU, DELL, ASML) carry
// multipliers slightly above 1.0 from dividends and adjustments — small enough
// to look like a genuine 0.05-0.3% edge rather than an obvious error, which is
// worse. Those are exactly the sizes a dislocation strategy trades.

export const MULTIPLIER_SCALE = 10n ** 18n;

/** Parse an 18-decimal fixed-point multiplier string ("4.000000000000000000"). */
export function parseMultiplier(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return MULTIPLIER_SCALE;
  const trimmed = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`unparseable multiplier: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const padded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * MULTIPLIER_SCALE + BigInt(padded || '0');
}

export function formatMultiplier(m: bigint): string {
  const whole = m / MULTIPLIER_SCALE;
  const frac = (m % MULTIPLIER_SCALE).toString().padStart(18, '0');
  return `${whole}.${frac}`;
}

/**
 * The reference price of ONE TOKEN, given the per-share underlying price.
 * This is the only number comparable to an onchain executable quote.
 */
export function normalizeStockTokenPrice(underlyingPricePerShare: number, multiplier: bigint): number {
  if (!Number.isFinite(underlyingPricePerShare) || underlyingPricePerShare < 0) {
    throw new Error(`bad underlying price: ${underlyingPricePerShare}`);
  }
  if (multiplier <= 0n) throw new Error('multiplier must be positive');
  return underlyingPricePerShare * (Number(multiplier) / Number(MULTIPLIER_SCALE));
}

/**
 * How many underlying shares a token balance represents. Exact — integer math
 * all the way, because this feeds position accounting, not a chart.
 */
export function normalizeUnderlyingExposure(rawTokenAmount: bigint, multiplier: bigint): bigint {
  if (multiplier <= 0n) throw new Error('multiplier must be positive');
  return (rawTokenAmount * multiplier) / MULTIPLIER_SCALE;
}

/** Inverse: raw token units needed to hold a given number of underlying shares. */
export function tokenAmountForExposure(underlyingShares: bigint, multiplier: bigint): bigint {
  if (multiplier <= 0n) throw new Error('multiplier must be positive');
  return (underlyingShares * MULTIPLIER_SCALE) / multiplier;
}

export interface PendingMultiplier {
  pending: boolean;
  current: bigint;
  next: bigint;
  effectiveAt: number | null;
  /** a change already in force but not yet seen by us is a reconciliation problem */
  overdue: boolean;
}

/**
 * A multiplier change is PENDING when the token advertises a different next
 * value with an effective time still in the future. Reading `newUIMultiplier()`
 * alone is not enough: when nothing is scheduled it simply equals the current
 * value, so equality — not nullness — is the signal.
 */
export function pendingMultiplier(
  current: bigint,
  next: bigint,
  effectiveAt: number | null,
  now = Date.now(),
): PendingMultiplier {
  const differs = next !== current && next > 0n;
  const effectiveMs = effectiveAt ? effectiveAt * 1000 : null;
  return {
    pending: differs && (effectiveMs === null || effectiveMs > now),
    current,
    next,
    effectiveAt,
    overdue: differs && effectiveMs !== null && effectiveMs <= now,
  };
}

/**
 * The multiplier that was in force at a historical instant.
 *
 * Backtests MUST use this. Running a 2026-06 backtest on CRWD with today's
 * 4.0 multiplier would show the token quadrupling overnight on the split date
 * and hand any momentum strategy a fabricated, unrepeatable win.
 */
export function multiplierAt(db: DB, symbol: string, ts: number): bigint {
  // UNIT BOUNDARY. `effective_at` is unix SECONDS because that is what the
  // contract's effectiveAt() returns; every timestamp elsewhere in this
  // codebase is milliseconds. Comparing the two directly makes the predicate
  // vacuously true — seconds are ~1e9, milliseconds ~1e12 — so the query
  // returns the newest row for every historical instant, which is exactly the
  // "backtest silently uses today's multiplier" failure this function exists
  // to prevent. Convert here, once, at the only place the two units meet.
  const effectiveAtSeconds = Math.floor(ts / 1000);
  const row = db
    .prepare(
      `SELECT multiplier FROM rh_multiplier_history
       WHERE symbol = ? AND effective_at <= ?
       ORDER BY effective_at DESC LIMIT 1`,
    )
    .get(symbol, effectiveAtSeconds) as { multiplier: string } | undefined;
  if (!row) {
    // No recorded history before this instant. Refusing is correct: silently
    // falling back to 1.0 (or to today's value) is how a split becomes a
    // backtested profit.
    throw new Error(
      `no multiplier recorded for ${symbol} at ${new Date(ts).toISOString()} — ` +
        'cannot backtest a Stock Token across a period whose multiplier is unknown',
    );
  }
  return parseMultiplier(row.multiplier);
}

export function recordMultiplier(
  db: DB,
  symbol: string,
  contractAddress: string,
  multiplier: bigint,
  effectiveAt: number,
  source: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO rh_multiplier_history
       (symbol, contract_address, chain_id, multiplier, effective_at, observed_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    symbol, contractAddress.toLowerCase(), ROBINHOOD_MAINNET_CHAIN_ID,
    formatMultiplier(multiplier), effectiveAt, Date.now(), source,
  );
}

export interface DislocationInput {
  /** raw per-share underlying reference price, straight from the API */
  underlyingPrice: number;
  multiplier: bigint;
  /** what the venue will actually fill at, for one token */
  executableBuy: number;
  executableSell: number;
}

export interface Dislocation {
  referenceTokenPrice: number;
  rawDislocationBps: number;
  direction: 'premium' | 'discount' | 'flat';
  /** the naive number, kept only so the UI can show what it avoided */
  naiveUnadjustedBps: number;
  multiplierApplied: string;
}

/**
 * Raw dislocation only — costs are subtracted downstream by the existing net
 * edge model. Reports the naive figure alongside so the terminal can show the
 * difference the multiplier made.
 */
export function measureDislocation(input: DislocationInput): Dislocation {
  const referenceTokenPrice = normalizeStockTokenPrice(input.underlyingPrice, input.multiplier);
  if (referenceTokenPrice <= 0) throw new Error('reference token price must be positive');

  const mid = (input.executableBuy + input.executableSell) / 2;
  const rawDislocationBps = ((mid - referenceTokenPrice) / referenceTokenPrice) * 10_000;
  const naiveUnadjustedBps =
    input.underlyingPrice > 0 ? ((mid - input.underlyingPrice) / input.underlyingPrice) * 10_000 : 0;

  return {
    referenceTokenPrice,
    rawDislocationBps,
    direction: rawDislocationBps > 1 ? 'premium' : rawDislocationBps < -1 ? 'discount' : 'flat',
    naiveUnadjustedBps,
    multiplierApplied: formatMultiplier(input.multiplier),
  };
}
