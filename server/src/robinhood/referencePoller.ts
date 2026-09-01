import type { DB } from '../db/db.js';
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
  opts: { fetchImpl?: typeof fetch; delayMs?: number } = {},
): Promise<ReferencePollResult> {
  const existing = activePolls.get(db);
  if (existing) return existing;
  const poll = runPoll(db, opts).finally(() => activePolls.delete(db));
  activePolls.set(db, poll);
  return poll;
}

async function runPoll(
  db: DB,
  opts: { fetchImpl?: typeof fetch; delayMs?: number },
): Promise<ReferencePollResult> {
  const snapshot = activeUniverse(db);
  if (!snapshot) throw new Error('no active universe snapshot');
  const result: ReferencePollResult = { attempted: 0, fresh: 0, failed: [] };
  for (const asset of universeAssets(db, snapshot.id)) {
    if (asset.symbol === 'USDG') continue;
    result.attempted++;
    const quote = await fetchReferenceQuote(db, asset.symbol, { fetchImpl: opts.fetchImpl });
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
