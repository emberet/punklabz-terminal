import { XP, levelForXp } from '@punklabz/shared';
import type { DB } from '../db/db.js';

// Event-sourced XP: unique (user, type, ref_id) makes awards idempotent,
// per-day caps are count queries, totals are indexed sums.

export type XpType =
  | 'deploy'
  | 'clone_received'
  | 'trade'
  | 'backtest'
  | 'daily_login'
  | 'season_finish';

/** Award XP. Returns the amount actually awarded (0 = deduped or capped). */
export function awardXp(db: DB, userId: number, type: XpType, amount: number, refId?: number): number {
  const now = Date.now();
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;

  if (type === 'trade') {
    const today = db
      .prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM xp_events WHERE user_id = ? AND type = 'trade' AND ts >= ?`)
      .get(userId, dayStart) as { s: number };
    if (today.s >= XP.tradeDailyCap) return 0;
  }
  if (type === 'backtest') {
    const today = db
      .prepare(`SELECT COUNT(*) AS n FROM xp_events WHERE user_id = ? AND type = 'backtest' AND ts >= ?`)
      .get(userId, dayStart) as { n: number };
    if (today.n >= XP.backtestDailyCap) return 0;
  }

  try {
    db.prepare(`INSERT INTO xp_events (user_id, type, amount, ref_id, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(userId, type, amount, refId ?? null, now);
    return amount;
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) return 0; // deduped on (user, type, ref_id)
    throw e;
  }
}

/** Idempotent daily-login XP: ref = UTC day number. */
export function awardDailyLogin(db: DB, userId: number): void {
  awardXp(db, userId, 'daily_login', XP.dailyLogin, Math.floor(Date.now() / 86_400_000));
}

export function xpTotal(db: DB, userId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM xp_events WHERE user_id = ?`)
    .get(userId) as { s: number };
  return row.s;
}

export function xpProfile(db: DB, userId: number) {
  const xp = xpTotal(db, userId);
  return { xp, ...levelForXp(xp) };
}
