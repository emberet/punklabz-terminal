import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import { emitActivity } from './activity.js';

/** INSERT OR IGNORE award — returns true only when newly earned. */
export function awardBadge(db: DB, hub: WsHub | null, userId: number, badge: string, seasonId = 0): boolean {
  const info = db
    .prepare(`INSERT OR IGNORE INTO user_badges (user_id, badge, season_id, awarded_at) VALUES (?, ?, ?, ?)`)
    .run(userId, badge, seasonId, Date.now());
  if (info.changes === 0) return false;
  emitActivity(db, hub, { type: 'badge', actorUserId: userId, payload: { badge, seasonId } });
  return true;
}

/** Called from the fill listener for quant trades: trade-count milestones. */
export function checkTradeBadges(db: DB, hub: WsHub | null, ownerUserId: number): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades t JOIN bots b ON b.id = t.bot_id WHERE b.owner_user_id = ?`,
    )
    .get(ownerUserId) as { n: number };
  if (row.n >= 10) awardBadge(db, hub, ownerUserId, 'trades_10');
  if (row.n >= 100) awardBadge(db, hub, ownerUserId, 'trades_100');
}

/** Called from the clone route: clones-received milestone for the creator. */
export function checkCloneBadges(db: DB, hub: WsHub | null, creatorUserId: number): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bots c
       WHERE c.cloned_from_bot_id IN (SELECT id FROM bots WHERE owner_user_id = ?)`,
    )
    .get(creatorUserId) as { n: number };
  if (row.n >= 5) awardBadge(db, hub, creatorUserId, 'clones_5');
}

/** Daily cron: 7 consecutive UTC days of day-over-day equity growth on any bot. */
export function checkStreakBadges(db: DB, hub: WsHub | null): void {
  const owners = db
    .prepare(`SELECT DISTINCT owner_user_id AS uid FROM bots WHERE owner_user_id IS NOT NULL`)
    .all() as { uid: number }[];
  for (const { uid } of owners) {
    const bots = db.prepare(`SELECT id FROM bots WHERE owner_user_id = ?`).all(uid) as { id: number }[];
    for (const { id } of bots) {
      // last equity snapshot per UTC day, most recent 8 days
      const days = db
        .prepare(
          `SELECT day, equity FROM (
             SELECT ts/86400000 AS day, equity_micro AS equity,
                    ROW_NUMBER() OVER (PARTITION BY ts/86400000 ORDER BY ts DESC) AS rn
             FROM bot_metrics WHERE bot_id = ?
           ) WHERE rn = 1 ORDER BY day DESC LIMIT 8`,
        )
        .all(id) as { day: number; equity: number }[];
      if (days.length < 8) continue;
      let streak = true;
      for (let i = 0; i < 7; i++) {
        if (!(days[i].day === days[i + 1].day + 1 && days[i].equity > days[i + 1].equity)) {
          streak = false;
          break;
        }
      }
      if (streak) awardBadge(db, hub, uid, 'streak_7d');
    }
  }
}

export function badgesFor(db: DB, userId: number) {
  return db
    .prepare(`SELECT badge, season_id AS seasonId, awarded_at AS awardedAt FROM user_badges WHERE user_id = ? ORDER BY awarded_at DESC`)
    .all(userId) as { badge: string; seasonId: number; awardedAt: number }[];
}
