import { ROBINHOOD_MAINNET_CHAIN_ID } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { appendAudit } from '../audit/auditLog.js';

// THE CORPORATE ACTION ENGINE.
//
// A stock split is not a 75% crash. A reverse split is not a moonshot. A
// dividend is not alpha. Every one of those events moves a price series in a
// way that looks exactly like the signal a momentum or mean-reversion strategy
// is built to chase, and the only defence is knowing the event is coming and
// standing down around it.
//
// Source: https://api.robinhood.com/rhj/corporate-actions — keyless, cached
// 1h. Verified live: it returns real forward-dated events (cash dividends with
// processDate in September 2026 at time of writing), so this is a real feed,
// not a placeholder.
//
// Policy: an instrument with an IN_PROGRESS action that changes share
// economics is not tradable until the action has processed AND the multiplier
// has been re-verified. Cash dividends do not change the multiplier and are
// recorded without blocking.

const CORPORATE_ACTIONS_URL = 'https://api.robinhood.com/rhj/corporate-actions';

/** Actions that change what one token represents. These block trading. */
const SHARE_CHANGING = new Set([
  'CORPORATE_ACTION_TYPE_STOCK_SPLIT',
  'CORPORATE_ACTION_TYPE_REVERSE_SPLIT',
  'CORPORATE_ACTION_TYPE_MERGER',
  'CORPORATE_ACTION_TYPE_SPINOFF',
  'CORPORATE_ACTION_TYPE_SYMBOL_CHANGE',
  'CORPORATE_ACTION_TYPE_STOCK_DIVIDEND',
  'CORPORATE_ACTION_TYPE_RIGHTS_OFFERING',
  'CORPORATE_ACTION_TYPE_DELISTING',
]);

const UNRESOLVED_STATUSES = new Set([
  'CORPORATE_ACTION_STATUS_IN_PROGRESS',
  'CORPORATE_ACTION_STATUS_PENDING',
  'CORPORATE_ACTION_STATUS_SCHEDULED',
]);

interface ApiCorpAction {
  id: string;
  type: string;
  status: string;
  processDate?: { year: number; month: number; day: number };
  tokenSymbol: string;
  deployments?: { contractAddress: string; chainId: number }[];
  details?: Record<string, unknown>;
}

/**
 * An unknown action type is treated as share-changing. A new event type we
 * have never seen is exactly the case where guessing "probably harmless" is
 * how a split gets traded through.
 */
export function blocksTrading(type: string, status: string): boolean {
  if (!UNRESOLVED_STATUSES.has(status)) return false;
  if (type === 'CORPORATE_ACTION_TYPE_CASH_DIVIDEND') return false;
  return SHARE_CHANGING.has(type) || !type.startsWith('CORPORATE_ACTION_TYPE_');
}

function toTimestamp(d?: { year: number; month: number; day: number }): number | null {
  if (!d) return null;
  return Date.UTC(d.year, d.month - 1, d.day);
}

export interface CorpActionReport {
  ok: boolean;
  seen: number;
  blocking: number;
  newlyBlocking: string[];
  error: string | null;
}

export async function refreshCorporateActions(
  db: DB,
  opts: { fetchImpl?: typeof fetch; chainId?: number } = {},
): Promise<CorpActionReport> {
  const doFetch = opts.fetchImpl ?? fetch;
  const chainId = opts.chainId ?? ROBINHOOD_MAINNET_CHAIN_ID;
  const report: CorpActionReport = { ok: false, seen: 0, blocking: 0, newlyBlocking: [], error: null };

  let actions: ApiCorpAction[];
  try {
    const res = await doFetch(CORPORATE_ACTIONS_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`corporate actions HTTP ${res.status}`);
    const body = (await res.json()) as { corpActions?: ApiCorpAction[] };
    if (!Array.isArray(body.corpActions)) throw new Error('no corpActions array');
    actions = body.corpActions;
  } catch (e) {
    report.error = String(e instanceof Error ? e.message : e).slice(0, 200);
    return report;
  }

  const previouslyBlocking = new Set(
    (db.prepare(`SELECT id FROM rh_corporate_actions WHERE blocks_trading = 1`).all() as { id: string }[])
      .map((r) => r.id),
  );

  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO rh_corporate_actions
       (id, type, status, symbol, contract_address, chain_id, process_date, process_ts,
        details_json, blocks_trading, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, process_date = excluded.process_date,
       process_ts = excluded.process_ts, details_json = excluded.details_json,
       blocks_trading = excluded.blocks_trading, updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    for (const a of actions) {
      report.seen++;
      const deployment = a.deployments?.find((d) => d.chainId === chainId) ?? a.deployments?.[0];
      const blocking = blocksTrading(a.type, a.status);
      if (blocking) {
        report.blocking++;
        if (!previouslyBlocking.has(a.id)) report.newlyBlocking.push(`${a.tokenSymbol}:${a.type}`);
      }
      const ts = toTimestamp(a.processDate);
      upsert.run(
        a.id, a.type, a.status, a.tokenSymbol,
        deployment?.contractAddress?.toLowerCase() ?? null, deployment?.chainId ?? null,
        a.processDate ? `${a.processDate.year}-${String(a.processDate.month).padStart(2, '0')}-${String(a.processDate.day).padStart(2, '0')}` : null,
        ts, JSON.stringify(a.details ?? {}), blocking ? 1 : 0, now, now,
      );
    }
  })();

  // Anything newly blocking is an event worth an audit entry — this is the
  // trail that explains why a machine stopped trading a symbol.
  if (report.newlyBlocking.length) {
    appendAudit(db, 'corporate-action-engine', 'instruments_paused', {
      instruments: report.newlyBlocking,
    });
  }

  report.ok = true;
  return report;
}

export interface CorpActionState {
  blocked: boolean;
  reason: string | null;
  actions: { id: string; type: string; status: string; processDate: string | null }[];
}

/** Whether a symbol is currently standing down for a corporate event. */
export function corporateActionState(db: DB, symbol: string): CorpActionState {
  const rows = db
    .prepare(
      `SELECT id, type, status, process_date, blocks_trading FROM rh_corporate_actions
       WHERE symbol = ? AND status IN ('CORPORATE_ACTION_STATUS_IN_PROGRESS','CORPORATE_ACTION_STATUS_PENDING','CORPORATE_ACTION_STATUS_SCHEDULED')
       ORDER BY process_ts ASC`,
    )
    .all(symbol) as any[];
  const blocking = rows.find((r) => r.blocks_trading === 1);
  return {
    blocked: !!blocking,
    reason: blocking
      ? `${blocking.type.replace('CORPORATE_ACTION_TYPE_', '')} ${blocking.status.replace('CORPORATE_ACTION_STATUS_', '').toLowerCase()}` +
        (blocking.process_date ? ` (processes ${blocking.process_date})` : '')
      : null,
    actions: rows.map((r) => ({ id: r.id, type: r.type, status: r.status, processDate: r.process_date })),
  };
}

/** Symbols currently standing down, for the terminal to show. */
export function pausedSymbols(db: DB): { symbol: string; reason: string }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT symbol, type, status, process_date FROM rh_corporate_actions
       WHERE blocks_trading = 1 ORDER BY symbol`,
    )
    .all() as any[];
  return rows.map((r) => ({
    symbol: r.symbol,
    reason: `${r.type.replace('CORPORATE_ACTION_TYPE_', '')}${r.process_date ? ` on ${r.process_date}` : ''}`,
  }));
}
