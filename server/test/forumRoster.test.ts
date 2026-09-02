import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { config } from '../src/config.js';
import { demoWindow, forumHeartbeat, forumRoster, post, recentPosts, SYSTEM_AGENTS } from '../src/toolkit/forum.js';
import { takeRateLimit } from '../src/research/budget.js';

const HOUSE = ['MOMENTUM RUNNER', 'MEAN REVERSION', 'GRID TRADER', 'PUMP SNIPER', 'HERD SENTIMENT'];

function seedBots(db: DB) {
  const user = db.prepare(
    `INSERT INTO users (email,display_name,created_at) VALUES ('forum@example.com','FORUM USER',?)`,
  ).run(Date.now());
  const stmt = db.prepare(
    `INSERT INTO bots (name, kind, strategy_type, config_json, status, public_chat_opt_in, owner_user_id, created_at)
     VALUES (?, ?, 'momentum', '{}', ?, ?, ?, ?)`,
  );
  for (const name of HOUSE) stmt.run(name, 'house', 'running', 0, null, Date.now());
  stmt.run('SOL RSI dip buyer', 'quant', 'running', 1, Number(user.lastInsertRowid), Date.now());
  stmt.run('RETIRED MACHINE', 'quant', 'stopped', 1, Number(user.lastInsertRowid), Date.now());
}

function speak(db: DB, name: string, at: number, kind: 'machine' | 'system_agent' = 'machine') {
  db.prepare(
    `INSERT INTO forum_posts (ts, author_kind, author_id, author_name, body, reply_to, topic)
     VALUES (?, ?, NULL, ?, 'x', NULL, NULL)`,
  ).run(at, kind, name);
}

describe('the forum roster', () => {
  let db: DB;
  beforeEach(() => {
    db = openTestDb();
    seedBots(db);
  });

  it('includes every running machine AND every system agent — not the first three', () => {
    const names = forumRoster(db).map((s) => s.name);
    // the bug: the old roster was `WHERE kind='house'` then .slice(0, 3), so
    // PUMP SNIPER and HERD SENTIMENT were never heard from
    for (const name of HOUSE) expect(names).toContain(name);
    expect(names).toContain('PUMP SNIPER');
    expect(names).toContain('HERD SENTIMENT');
    for (const agent of Object.keys(SYSTEM_AGENTS)) expect(names).toContain(agent);
    expect(names.length).toBe(HOUSE.length + 1 + Object.keys(SYSTEM_AGENTS).length);
  });

  it('includes quant-owned machines, which the old house-only filter excluded', () => {
    expect(forumRoster(db).map((s) => s.name)).toContain('SOL RSI dip buyer');
  });

  it('keeps user-owned machines private until their owner opts them in', () => {
    db.prepare(`UPDATE bots SET public_chat_opt_in=0 WHERE name='SOL RSI dip buyer'`).run();
    expect(forumRoster(db).map((s) => s.name)).not.toContain('SOL RSI dip buyer');
  });

  it('excludes machines that are not running', () => {
    expect(forumRoster(db).map((s) => s.name)).not.toContain('RETIRED MACHINE');
  });

  it('orders by who has been quiet longest, never-spoken first', () => {
    const now = Date.now();
    for (const name of HOUSE) speak(db, name, now - 1000);
    speak(db, 'RISK CORE', now - 60_000, 'system_agent');

    const roster = forumRoster(db);
    // SCANNER, MANAGER and the quant bot have never spoken
    expect(roster[0].lastSpokeAt).toBe(0);
    // and the most recent speaker is last
    expect(roster[roster.length - 1].lastSpokeAt).toBe(now - 1000);
  });

  it('a human posting does not count as an agent speaking', () => {
    post(db, null, {
      authorKind: 'human', authorId: 1, authorName: 'MOMENTUM RUNNER',
      body: 'impersonation attempt', replyTo: null, topic: null,
    });
    expect(forumRoster(db).find((s) => s.name === 'MOMENTUM RUNNER')!.lastSpokeAt).toBe(0);
  });

  it('rotation reaches every agent before repeating anyone', () => {
    // simulate the heartbeat's selection rule over a full cycle
    const spoken: string[] = [];
    const size = forumRoster(db).length;
    for (let i = 0; i < size; i++) {
      const next = forumRoster(db)[0];
      speak(db, next.name, Date.now() + i, next.kind);
      spoken.push(next.name);
    }
    expect(new Set(spoken).size).toBe(size);
  });
});

describe('the heartbeat', () => {
  let db: DB;
  let previousKey: string;

  beforeEach(() => {
    db = openTestDb();
    seedBots(db);
    previousKey = config.anthropicApiKey;
    config.anthropicApiKey = ''; // never reach the live API from a test
  });

  it('says nothing and spends nothing without an API key', async () => {
    const r = await forumHeartbeat(db, null as any, null as any, () => 1);
    expect(r.spoke).toBeNull();
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(recentPosts(db)).toHaveLength(0);
    config.anthropicApiKey = previousKey;
  });

  it('the cadence limit is persistent, so a restart loop cannot spam the room', () => {
    const spec = { cooldownMs: 4.5 * 60_000, maxInWindow: 320, windowMs: 86_400_000 };
    expect(takeRateLimit(db, 'forum:heartbeat', spec).allowed).toBe(true);
    // a second tick inside the cooldown is refused, and would be after a
    // restart too — the state is in the database, not a module variable
    expect(takeRateLimit(db, 'forum:heartbeat', spec).allowed).toBe(false);
    config.anthropicApiKey = previousKey;
  });

  it('caps the day even if the cron fires far more often than intended', () => {
    const spec = { cooldownMs: 0, maxInWindow: 320, windowMs: 86_400_000 };
    let allowed = 0;
    for (let i = 0; i < 400; i++) {
      if (takeRateLimit(db, 'forum:heartbeat', spec).allowed) allowed++;
    }
    expect(allowed).toBe(320);
    config.anthropicApiKey = previousKey;
  });

  it('the window opens on the FIRST TICK, not at boot', () => {
    // a deploy an hour before anyone looks must not burn an hour of the demo
    const before = demoWindow(db, 24);
    expect(before.open).toBe(true);
    expect(before.openedAt).toBeNull();
    expect(before.reason).toMatch(/opens on the first tick/);
    expect(db.prepare(`SELECT COUNT(*) n FROM forum_demo`).get()).toEqual({ n: 0 });
    config.anthropicApiKey = previousKey;
  });

  it('goes quiet once the window has elapsed', () => {
    const opened = Date.now() - 25 * 3_600_000;
    db.prepare(`INSERT INTO forum_demo (id, opened_at, hours, posts) VALUES (1, ?, 24, 288)`).run(opened);

    const w = demoWindow(db, 24);
    expect(w.open).toBe(false);
    expect(w.msRemaining).toBe(0);
    expect(w.reason).toMatch(/closed after 24h — 288 post\(s\)/);
    config.anthropicApiKey = previousKey;
  });

  it('records the close once, as an event rather than a re-derivation', () => {
    db.prepare(`INSERT INTO forum_demo (id, opened_at, hours) VALUES (1, ?, 24)`)
      .run(Date.now() - 25 * 3_600_000);
    demoWindow(db, 24);
    const first = (db.prepare(`SELECT closed_at FROM forum_demo WHERE id=1`).get() as any).closed_at;
    expect(first).toBeGreaterThan(0);
    demoWindow(db, 24);
    expect((db.prepare(`SELECT closed_at FROM forum_demo WHERE id=1`).get() as any).closed_at).toBe(first);
    config.anthropicApiKey = previousKey;
  });

  it('A RESTART DOES NOT EXTEND THE WINDOW', () => {
    // the bug this guards: opened_at in memory means every systemctl restart
    // grants another full day. It is the lastAutoPost mistake, in the same file.
    const opened = Date.now() - 12 * 3_600_000;
    db.prepare(`INSERT INTO forum_demo (id, opened_at, hours, posts) VALUES (1, ?, 24, 144)`).run(opened);

    // "restart": nothing in memory survives, everything is re-read from the DB
    const afterRestart = demoWindow(db, 24);
    expect(afterRestart.openedAt).toBe(opened);
    expect(afterRestart.msRemaining / 3_600_000).toBeCloseTo(12, 0);

    // and the window still closes at the ORIGINAL time, not 24h from the restart
    expect(demoWindow(db, 24, opened + 25 * 3_600_000).open).toBe(false);
    config.anthropicApiKey = previousKey;
  });

  it('a closed window costs nothing — no limiter write, no budget read, no model call', async () => {
    db.prepare(`INSERT INTO forum_demo (id, opened_at, hours) VALUES (1, ?, 24)`)
      .run(Date.now() - 25 * 3_600_000);
    config.anthropicApiKey = 'sk-ant-not-real';

    const r = await forumHeartbeat(db, null as any, null as any, () => 1, { hours: 24 });
    expect(r.spoke).toBeNull();
    expect(r.reason).toMatch(/closed after 24h/);
    // the rate limiter was never touched, so nothing was consumed
    expect(db.prepare(`SELECT COUNT(*) n FROM agent_rate_limits WHERE key='forum:heartbeat'`).get())
      .toEqual({ n: 0 });
    config.anthropicApiKey = previousKey;
  });

  it('hours <= 0 means no window at all', () => {
    expect(demoWindow(db, 0).open).toBe(true);
    expect(demoWindow(db, 0).msRemaining).toBe(Infinity);
    expect(demoWindow(db, -1).reason).toMatch(/runs indefinitely/);
    config.anthropicApiKey = previousKey;
  });

  it('uses a separate budget key from the event-driven poster', () => {
    // heartbeat and autopost must not share a cooldown, or an event burst
    // would silence the clock and vice versa
    const spec = { cooldownMs: 10 * 60_000 };
    expect(takeRateLimit(db, 'forum:heartbeat', spec).allowed).toBe(true);
    expect(takeRateLimit(db, 'forum:autopost', spec).allowed).toBe(true);
    config.anthropicApiKey = previousKey;
  });
});
