import { describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { awardXp, awardDailyLogin, xpTotal } from '../src/social/xp.js';
import { awardBadge } from '../src/social/badges.js';
import { emitActivity, readEvents } from '../src/social/activity.js';
import { closeDueSeasons, currentSeason, ensureActiveSeason } from '../src/social/seasons.js';
import { toMicro } from '../src/money.js';
import { XP, levelForXp } from '@punklabz/shared';

function mkUser(db: DB, email: string): number {
  return Number(
    db.prepare(`INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)`).run(email, email, Date.now())
      .lastInsertRowid,
  );
}

function mkBot(db: DB, ownerId: number | null, equityMicro: number, createdAt = 1): number {
  const id = Number(
    db.prepare(`INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, created_at) VALUES (?, 'b', ?, 'x', '{}', ?)`)
      .run(ownerId, ownerId ? 'quant' : 'house', createdAt).lastInsertRowid,
  );
  db.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, 1)`)
    .run(id, equityMicro, toMicro(10_000));
  return id;
}

describe('xp', () => {
  it('dedupes on (user, type, ref) and enforces daily caps', () => {
    const db = openTestDb();
    const u = mkUser(db, 'x@x.com');
    expect(awardXp(db, u, 'deploy', XP.deploy, 1)).toBe(XP.deploy);
    expect(awardXp(db, u, 'deploy', XP.deploy, 1)).toBe(0); // dedup
    expect(awardXp(db, u, 'deploy', XP.deploy, 2)).toBe(XP.deploy);

    // trade cap: 40/day at 2xp = 20 trades
    let total = 0;
    for (let i = 0; i < 30; i++) total += awardXp(db, u, 'trade', XP.trade, 100 + i);
    expect(total).toBe(XP.tradeDailyCap);

    awardDailyLogin(db, u);
    awardDailyLogin(db, u); // same UTC day -> deduped
    expect(xpTotal(db, u)).toBe(XP.deploy * 2 + XP.tradeDailyCap + XP.dailyLogin);
  });

  it('level thresholds are deterministic', () => {
    expect(levelForXp(0).title).toBe('NOVICE');
    expect(levelForXp(100).title).toBe('PAPERHAND');
    expect(levelForXp(12000).title).toBe('LEGEND');
    expect(levelForXp(12000).nextAt).toBeNull();
  });
});

describe('badges + activity', () => {
  it('badge awards are idempotent and emit one feed event', () => {
    const db = openTestDb();
    const u = mkUser(db, 'b@x.com');
    expect(awardBadge(db, null, u, 'first_deploy')).toBe(true);
    expect(awardBadge(db, null, u, 'first_deploy')).toBe(false);
    const events = readEvents(db, { limit: 10 });
    expect(events.filter((e) => e.type === 'badge')).toHaveLength(1);
  });

  it('feed pagination cursors work', () => {
    const db = openTestDb();
    for (let i = 0; i < 25; i++) emitActivity(db, null, { type: 'deploy', payload: { i } });
    const page1 = readEvents(db, { limit: 10 });
    expect(page1).toHaveLength(10);
    const page2 = readEvents(db, { limit: 10, before: page1[page1.length - 1].id });
    expect(page2).toHaveLength(10);
    expect(page2[0].id).toBeLessThan(page1[page1.length - 1].id);
  });
});

describe('seasons', () => {
  it('boot creates one active season, idempotently', () => {
    const db = openTestDb();
    const s1 = ensureActiveSeason(db, null);
    const s2 = ensureActiveSeason(db, null);
    expect(s1.id).toBe(s2.id);
    expect(s1.name).toBe('SEASON 01');
  });

  it('closing a due season ranks by baseline pnl, awards quant owners only, starts the next', () => {
    const db = openTestDb();
    const quant = mkUser(db, 'q@x.com');
    // season that ended a minute ago
    db.prepare(`INSERT INTO seasons (name, starts_at, ends_at, status, created_at) VALUES ('SEASON 01', ?, ?, 'active', ?)`)
      .run(Date.now() - 86_400_000, Date.now() - 60_000, Date.now());
    const seasonStart = Date.now() - 86_400_000;

    const houseBot = mkBot(db, null, toMicro(11_000));   // +10% (house — no rewards)
    const quantBot = mkBot(db, quant, toMicro(10_500));  // +5%
    // baselines: both had 10k equity at season start
    for (const id of [houseBot, quantBot]) {
      db.prepare(`INSERT INTO bot_metrics (bot_id, ts, equity_micro, realized_pnl_micro, unrealized_pnl_micro, trade_count, win_count) VALUES (?, ?, ?, 0, 0, 0, 0)`)
        .run(id, seasonStart + 1000, toMicro(10_000));
    }
    const equityOf = (botId: number) =>
      botId === houseBot ? toMicro(11_000) : toMicro(10_500);

    closeDueSeasons(db, null, equityOf);

    const results = db.prepare(`SELECT * FROM season_results ORDER BY rank`).all() as any[];
    expect(results[0].bot_id).toBe(houseBot);
    expect(results[0].pnl_pct).toBeCloseTo(10);
    expect(results[1].bot_id).toBe(quantBot);
    expect(results[1].pnl_pct).toBeCloseTo(5);

    // quant owner got badge + xp; nothing for the house bot
    const badges = db.prepare(`SELECT user_id, badge FROM user_badges`).all() as any[];
    expect(badges).toHaveLength(1);
    expect(badges[0].user_id).toBe(quant);
    expect(badges[0].badge).toBe('season_top10');
    expect(xpTotal(db, quant)).toBe(XP.seasonTop3); // rank 2 -> top3 award

    // next season auto-started
    const next = currentSeason(db);
    expect(next).not.toBeNull();
    expect(next!.name).toBe('SEASON 02');

    // rerun is safe (idempotent)
    closeDueSeasons(db, null, equityOf);
    expect((db.prepare(`SELECT COUNT(*) n FROM user_badges`).get() as any).n).toBe(1);
  });
});
