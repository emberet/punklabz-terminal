import { XP } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import { emitActivity } from './activity.js';
import { awardBadge } from './badges.js';
import { awardXp } from './xp.js';

const SEASON_LENGTH_MS = 14 * 86_400_000;

export interface SeasonRow {
  id: number;
  name: string;
  starts_at: number;
  ends_at: number;
  status: 'upcoming' | 'active' | 'closed';
}

export function currentSeason(db: DB): SeasonRow | null {
  return (db
    .prepare(`SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`)
    .get() as SeasonRow | undefined) ?? null;
}

/** Boot: guarantee an active season exists. */
export function ensureActiveSeason(db: DB, hub: WsHub | null): SeasonRow {
  const existing = currentSeason(db);
  if (existing) return existing;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM seasons`).get() as { n: number };
  const now = Date.now();
  const name = `SEASON ${String(count.n + 1).padStart(2, '0')}`;
  const info = db
    .prepare(`INSERT INTO seasons (name, starts_at, ends_at, status, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(name, now, now + SEASON_LENGTH_MS, now);
  emitActivity(db, hub, { type: 'season_start', payload: { name } });
  return db.prepare(`SELECT * FROM seasons WHERE id = ?`).get(Number(info.lastInsertRowid)) as SeasonRow;
}

/** Per-bot season baseline: first metrics row at/after season start, else initial balance. */
export function seasonBaselineMicro(db: DB, botId: number, startsAt: number): number {
  const m = db
    .prepare(`SELECT equity_micro FROM bot_metrics WHERE bot_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1`)
    .get(botId, startsAt) as { equity_micro: number } | undefined;
  if (m) return m.equity_micro;
  const a = db.prepare(`SELECT initial_balance_micro FROM bot_accounts WHERE bot_id = ?`).get(botId) as
    | { initial_balance_micro: number }
    | undefined;
  return a?.initial_balance_micro ?? 0;
}

export interface SeasonStanding {
  botId: number;
  ownerUserId: number | null;
  baselineMicro: number;
  finalMicro: number;
  pnlPct: number;
}

export function seasonStandings(
  db: DB,
  season: SeasonRow,
  equityOf: (botId: number) => number,
): SeasonStanding[] {
  const bots = db
    .prepare(`SELECT id, owner_user_id FROM bots WHERE created_at < ?`)
    .all(season.ends_at) as { id: number; owner_user_id: number | null }[];
  const rows = bots.map((b) => {
    const baseline = seasonBaselineMicro(db, b.id, season.starts_at);
    const final = equityOf(b.id);
    return {
      botId: b.id,
      ownerUserId: b.owner_user_id,
      baselineMicro: baseline,
      finalMicro: final,
      pnlPct: baseline > 0 ? ((final - baseline) / baseline) * 100 : 0,
    };
  });
  rows.sort((a, b) => b.pnlPct - a.pnlPct);
  return rows;
}

/**
 * Cron (per minute): close any active season past its end — write results,
 * award top-10 badges/XP to quant owners, start the next season.
 * All writes are idempotent, so a crashed pass can rerun safely.
 */
export function closeDueSeasons(db: DB, hub: WsHub | null, equityOf: (botId: number) => number): void {
  const due = db
    .prepare(`SELECT * FROM seasons WHERE status = 'active' AND ends_at <= ?`)
    .all(Date.now()) as SeasonRow[];
  for (const season of due) {
    const standings = seasonStandings(db, season, equityOf);
    const tx = db.transaction(() => {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO season_results (season_id, bot_id, rank, pnl_pct, baseline_equity_micro, final_equity_micro)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      standings.forEach((s, i) =>
        stmt.run(season.id, s.botId, i + 1, s.pnlPct, s.baselineMicro, s.finalMicro),
      );
      db.prepare(`UPDATE seasons SET status = 'closed' WHERE id = ?`).run(season.id);
    });
    tx();

    standings.slice(0, 10).forEach((s, i) => {
      if (s.ownerUserId === null) return; // house bots rank but earn nothing
      awardBadge(db, hub, s.ownerUserId, 'season_top10', season.id);
      const xp = i === 0 ? XP.season1st : i < 3 ? XP.seasonTop3 : XP.seasonTop10;
      awardXp(db, s.ownerUserId, 'season_finish', xp, season.id);
    });

    emitActivity(db, hub, {
      type: 'season_end',
      payload: { name: season.name, topBotId: standings[0]?.botId ?? null },
    });
    ensureActiveSeason(db, hub);
  }
}
