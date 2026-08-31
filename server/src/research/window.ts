import type { DB } from '../db/db.js';
import { appendAudit } from '../audit/auditLog.js';
import { getLiveConfig, updateLimits } from '../live/riskEngine.js';

// THE RESEARCH WINDOW.
//
// A bounded period of deliberately looser trading, opened to generate outcome
// data. It exists because the confidence-weight loop cannot learn from trades
// that never happened: at a 90 confidence threshold on a quiet market the
// network can run for days and approve nothing, which is correct behaviour and
// also produces no evidence.
//
// It is NOT a "maximum risk" switch, and the difference matters. The things it
// relaxes are thresholds — how sure the network must be, how many positions it
// may hold, how large each one is. The things that stop a bad run are
// untouched: the drawdown circuit breaker, the daily-loss stop, the kill
// switch, leverage staying off, and the enclave's own spending cap. A window
// that could disable those would not be an experiment, it would be a way to
// lose the account quickly with extra steps.
//
// The window auto-closes on time and restores the settings captured when it
// opened. `opened_at` and the restore payload both live in the database, so a
// restart cannot extend the window or lose the way back.

export interface WindowSettings {
  confidenceThreshold: number;
  maxSimultaneousPositions: number;
  maxPerTradePct: number;
}

export interface ResearchWindow {
  open: boolean;
  id: number | null;
  openedAt: number | null;
  closesAt: number | null;
  hoursRemaining: number;
  settings: WindowSettings | null;
  reason: string;
}

export function currentWindow(db: DB, now = Date.now()): ResearchWindow {
  const row = db
    .prepare(`SELECT * FROM research_window WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get() as any;
  if (!row) {
    return { open: false, id: null, openedAt: null, closesAt: null, hoursRemaining: 0, settings: null, reason: 'no window open' };
  }
  const remaining = row.closes_at - now;
  return {
    open: remaining > 0,
    id: row.id,
    openedAt: row.opened_at,
    closesAt: row.closes_at,
    hoursRemaining: Math.max(0, remaining / 3_600_000),
    settings: {
      confidenceThreshold: row.confidence_threshold,
      maxSimultaneousPositions: row.max_positions,
      maxPerTradePct: row.max_per_trade_pct,
    },
    reason: remaining > 0
      ? `${(remaining / 3_600_000).toFixed(1)}h remaining`
      : 'window elapsed — awaiting close',
  };
}

export interface OpenWindowArgs {
  hours: number;
  confidenceThreshold: number;
  maxSimultaneousPositions: number;
  maxPerTradePct: number;
  actor: string;
}

export function openWindow(db: DB, args: OpenWindowArgs): ResearchWindow {
  const existing = currentWindow(db);
  if (existing.open) throw new Error(`a research window is already open (${existing.reason})`);

  const cfg = getLiveConfig(db);
  // Captured BEFORE anything is changed, so the way back is recorded even if
  // the process dies one line later.
  const restore = {
    confidenceThreshold: cfg.limits.confidenceThreshold,
    maxSimultaneousPositions: cfg.limits.maxSimultaneousPositions,
    maxPerTradePct: cfg.limits.maxPerTradePct,
  };

  const now = Date.now();
  const closesAt = now + args.hours * 3_600_000;
  const info = db
    .prepare(
      `INSERT INTO research_window
         (opened_at, hours, closes_at, actor, confidence_threshold, max_positions, max_per_trade_pct, restore_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now, args.hours, closesAt, args.actor,
      args.confidenceThreshold, args.maxSimultaneousPositions, args.maxPerTradePct,
      JSON.stringify(restore));

  // updateLimits applies its own hard clamps, which the window cannot exceed.
  updateLimits(db, {
    confidenceThreshold: args.confidenceThreshold,
    maxSimultaneousPositions: args.maxSimultaneousPositions,
    maxPerTradePct: args.maxPerTradePct,
  }, args.actor);

  appendAudit(db, args.actor, 'research_window_open', {
    windowId: Number(info.lastInsertRowid), hours: args.hours, applied: args, restore,
  });
  return currentWindow(db);
}

export interface CloseReport {
  closed: boolean;
  windowId: number | null;
  ordersPlaced: number;
  fills: number;
  realizedPnlUsd: number;
  restored: WindowSettings | null;
  detail: string;
}

/**
 * Close an elapsed window and restore what it replaced. Runs on a cron, so the
 * window ends on time whether or not anyone is watching — an experiment that
 * only stops when someone remembers is not time-boxed.
 */
export function closeIfElapsed(db: DB, actor = 'system', now = Date.now()): CloseReport {
  const row = db
    .prepare(`SELECT * FROM research_window WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get() as any;
  if (!row) return { closed: false, windowId: null, ordersPlaced: 0, fills: 0, realizedPnlUsd: 0, restored: null, detail: 'no window open' };
  if (row.closes_at > now) {
    return {
      closed: false, windowId: row.id, ordersPlaced: 0, fills: 0, realizedPnlUsd: 0, restored: null,
      detail: `${((row.closes_at - now) / 3_600_000).toFixed(1)}h remaining`,
    };
  }

  const stats = db
    .prepare(
      `SELECT COUNT(*) placed,
              SUM(CASE WHEN state = 'filled' THEN 1 ELSE 0 END) fills
       FROM live_orders WHERE created_at >= ? AND created_at <= ?`,
    )
    .get(row.opened_at, row.closes_at) as { placed: number; fills: number | null };
  const pnl = db
    .prepare(`SELECT COALESCE(SUM(realized_pnl_micro), 0) p FROM live_ledger WHERE ts >= ? AND ts <= ?`)
    .get(row.opened_at, row.closes_at) as { p: number };

  const restore = JSON.parse(row.restore_json) as WindowSettings;
  updateLimits(db, restore, actor);

  db.prepare(
    `UPDATE research_window SET closed_at = ?, orders_placed = ?, fills = ?, realized_pnl_micro = ? WHERE id = ?`,
  ).run(now, stats.placed, stats.fills ?? 0, pnl.p, row.id);

  appendAudit(db, actor, 'research_window_close', {
    windowId: row.id, ordersPlaced: stats.placed, fills: stats.fills ?? 0, realizedPnlMicro: pnl.p, restored: restore,
  });

  return {
    closed: true,
    windowId: row.id,
    ordersPlaced: stats.placed,
    fills: stats.fills ?? 0,
    realizedPnlUsd: pnl.p / 1_000_000,
    restored: restore,
    detail: `window ${row.id} closed: ${stats.placed} order(s), ${stats.fills ?? 0} fill(s), settings restored`,
  };
}

/** Close early — the operator changed their mind, or something looks wrong. */
export function closeNow(db: DB, actor: string): CloseReport {
  const row = db.prepare(`SELECT closes_at FROM research_window WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`).get() as any;
  if (!row) return { closed: false, windowId: null, ordersPlaced: 0, fills: 0, realizedPnlUsd: 0, restored: null, detail: 'no window open' };
  db.prepare(`UPDATE research_window SET closes_at = ? WHERE closed_at IS NULL`).run(Date.now() - 1);
  return closeIfElapsed(db, actor);
}
