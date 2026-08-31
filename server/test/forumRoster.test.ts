import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { config } from '../src/config.js';
import { forumHeartbeat, forumRoster, post, recentPosts, SYSTEM_AGENTS } from '../src/toolkit/forum.js';
import { takeRateLimit } from '../src/research/budget.js';

const HOUSE = ['MOMENTUM RUNNER', 'MEAN REVERSION', 'GRID TRADER', 'PUMP SNIPER', 'HERD SENTIMENT'];

function seedBots(db: DB) {
  const stmt = db.prepare(
    `INSERT INTO bots (name, kind, strategy_type, config_json, status, created_at) VALUES (?, ?, 'momentum', '{}', ?, ?)`,
  );
  for (const name of HOUSE) stmt.run(name, 'house', 'running', Date.now());
  stmt.run('SOL RSI dip buyer', 'quant', 'running', Date.now());
  stmt.run('RETIRED MACHINE', 'quant', 'stopped', Date.now());
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

  it('uses a separate budget key from the event-driven poster', () => {
    // heartbeat and autopost must not share a cooldown, or an event burst
    // would silence the clock and vice versa
    const spec = { cooldownMs: 10 * 60_000 };
    expect(takeRateLimit(db, 'forum:heartbeat', spec).allowed).toBe(true);
    expect(takeRateLimit(db, 'forum:autopost', spec).allowed).toBe(true);
    config.anthropicApiKey = previousKey;
  });
});
