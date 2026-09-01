import type { DB } from '../db/db.js';
import type { ReferenceQuote } from '@punklabz/shared';
import { fetchReferenceQuote } from './referencePrice.js';
import { recordReferenceBarFromString } from './referenceBars.js';
import { activeUniverse, universeAssets } from './universe.js';

export interface ReferencePollResult {
  attempted: number;
  fresh: number;
  failed: string[];
}

/** Refresh every snapshot asset before a sweep; partial refreshes are visible and unusable. */
const activePolls = new WeakMap<DB, Promise<ReferencePollResult>>();

export function pollUniverseReferences(
  db: DB,
  opts: { fetchImpl?: typeof fetch; delayMs?: number; ethUsd?: number; now?: number } = {},
): Promise<ReferencePollResult> {
  const existing = activePolls.get(db);
  if (existing) return existing;
  const poll = runPoll(db, opts).finally(() => activePolls.delete(db));
  activePolls.set(db, poll);
  return poll;
}

async function runPoll(
  db: DB,
  opts: { fetchImpl?: typeof fetch; delayMs?: number; ethUsd?: number; now?: number },
): Promise<ReferencePollResult> {
  const snapshot = activeUniverse(db);
  if (!snapshot) throw new Error('no active universe snapshot');
  const result: ReferencePollResult = { attempted: 0, fresh: 0, failed: [] };
  for (const asset of universeAssets(db, snapshot.id)) {
    if (asset.symbol === 'USDG') continue;
    result.attempted++;
    const quote = asset.symbol === 'WETH'
      ? recordWethReference(db, opts.ethUsd, opts.now ?? Date.now())
      : await fetchReferenceQuote(db, asset.symbol, { fetchImpl: opts.fetchImpl, now: opts.now });
    if (!quote || quote.stale || quote.isTradingHalt) {
      result.failed.push(asset.symbol);
    } else {
      recordReferenceBarFromString(db, quote, asset.multiplier);
      result.fresh++;
    }
    if ((opts.delayMs ?? 20) > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs ?? 20));
    }
  }
  return result;
}

function recordWethReference(db: DB, ethUsd: number | undefined, now: number): ReferenceQuote | null {
  if (!Number.isFinite(ethUsd) || !ethUsd || ethUsd <= 0) return null;
  db.prepare(
    `INSERT INTO rh_reference_prices
      (symbol,bid,ask,currency,is_trading_halt,generated_at,fetched_at,source)
     VALUES ('WETH',?,?, 'USD',0,?,?, 'binance_mark')`,
  ).run(ethUsd, ethUsd, now, Date.now());
  return { symbol: 'WETH', source: 'binance_mark', bid: ethUsd, ask: ethUsd, mid: ethUsd,
    currency: 'USD', isTradingHalt: false, generatedAt: now, ageMs: 0, stale: false };
}
