import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProfileView } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { currentUser, requireUser } from './auth.js';
import { readEvents } from '../../social/activity.js';
import { badgesFor } from '../../social/badges.js';
import { xpProfile } from '../../social/xp.js';
import { currentSeason, seasonStandings } from '../../social/seasons.js';
import { botSummaries, leaderboard } from '../queries.js';
import { fromMicro } from '../../money.js';

export function registerSocialRoutes(server: FastifyInstance, app: AppContext) {
  const markOf = (s: string) => app.executor.getMark(s);

  // ── feed ──
  server.get('/api/feed', async (request) => {
    const q = z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      before: z.coerce.number().optional(),
      user: z.coerce.number().optional(),
    }).parse(request.query);
    const events = readEvents(app.db, { limit: q.limit, before: q.before, userId: q.user });
    return { events, nextBefore: events.length === q.limit ? events[events.length - 1].id : null };
  });

  // ── seasons ──
  server.get('/api/seasons/current', async (request, reply) => {
    const season = currentSeason(app.db);
    if (!season) return reply.code(404).send({ error: 'no active season' });
    return {
      season: { id: season.id, name: season.name, startsAt: season.starts_at, endsAt: season.ends_at },
      countdownMs: Math.max(0, season.ends_at - Date.now()),
    };
  });

  server.get('/api/seasons/:id/results', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const rows = app.db
      .prepare(
        `SELECT r.rank, r.pnl_pct, r.bot_id, b.name, u.display_name AS owner
         FROM season_results r JOIN bots b ON b.id = r.bot_id
         LEFT JOIN users u ON u.id = b.owner_user_id
         WHERE r.season_id = ? ORDER BY r.rank ASC`,
      )
      .all(id);
    if (!rows.length) return reply.code(404).send({ error: 'no results for that season' });
    return { results: rows };
  });

  // ── follows ──
  server.post('/api/follow/toggle', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({
      targetType: z.enum(['user', 'bot']),
      targetId: z.number().int(),
    }).parse(request.body);

    if (body.targetType === 'user') {
      if (body.targetId === user.id) return reply.code(400).send({ error: 'cannot follow yourself' });
      const target = app.db.prepare('SELECT id FROM users WHERE id = ?').get(body.targetId);
      if (!target) return reply.code(404).send({ error: 'user not found' });
    } else {
      const bot = app.db.prepare('SELECT is_public FROM bots WHERE id = ?').get(body.targetId) as any;
      if (!bot) return reply.code(404).send({ error: 'bot not found' });
    }

    const existing = app.db
      .prepare(`SELECT 1 FROM follows WHERE follower_user_id = ? AND target_type = ? AND target_id = ?`)
      .get(user.id, body.targetType, body.targetId);
    if (existing) {
      app.db
        .prepare(`DELETE FROM follows WHERE follower_user_id = ? AND target_type = ? AND target_id = ?`)
        .run(user.id, body.targetType, body.targetId);
      return { following: false };
    }
    app.db
      .prepare(`INSERT INTO follows (follower_user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(user.id, body.targetType, body.targetId, Date.now());
    return { following: true };
  });

  // ── profiles (addressed by id; display names are cosmetic) ──
  server.get('/api/users/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const row = app.db
      .prepare(`SELECT id, display_name, created_at FROM users WHERE id = ?`)
      .get(id) as { id: number; display_name: string; created_at: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'user not found' });

    const viewer = currentUser(app, request);
    const xp = xpProfile(app.db, id);
    const allBots = botSummaries(app.db, markOf);
    const bots = allBots.filter((b) => {
      const owner = app.db.prepare('SELECT owner_user_id FROM bots WHERE id = ?').get(b.id) as any;
      return owner?.owner_user_id === id;
    });
    const botIds = bots.map((b) => b.id);

    const board = leaderboard(app.db, markOf, 86_400_000);
    const ranks = board.filter((r) => botIds.includes(r.botId)).map((r) => r.rank);

    const clonesReceived = botIds.length
      ? (app.db
          .prepare(`SELECT COUNT(*) AS n FROM bots WHERE cloned_from_bot_id IN (${botIds.join(',')})`)
          .get() as { n: number }).n
      : 0;
    const earnings = app.db
      .prepare(`SELECT COALESCE(SUM(amount_micro),0) AS s FROM ledger_entries WHERE type = 'fee_reuse' AND credit_account = ?`)
      .get(`user:${id}`) as { s: number };
    const followers = app.db
      .prepare(`SELECT COUNT(*) AS n FROM follows WHERE target_type = 'user' AND target_id = ?`)
      .get(id) as { n: number };
    const following = app.db
      .prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_user_id = ?`)
      .get(id) as { n: number };
    const isFollowing = viewer
      ? !!app.db
          .prepare(`SELECT 1 FROM follows WHERE follower_user_id = ? AND target_type = 'user' AND target_id = ?`)
          .get(viewer.id, id)
      : false;

    const totalInitial = bots.reduce((s, b) => s + b.initialBalanceUsd, 0);
    const totalEquity = bots.reduce((s, b) => s + b.equityUsd, 0);

    const profile: ProfileView = {
      user: {
        id: row.id,
        displayName: row.display_name,
        createdAt: row.created_at,
        xp: xp.xp,
        level: xp.level,
        levelTitle: xp.title,
        nextLevelAt: xp.nextAt,
      },
      followers: followers.n,
      following: following.n,
      isFollowing,
      badges: badgesFor(app.db, id),
      bots,
      bestRank: ranks.length ? Math.min(...ranks) : null,
      portfolioPnlUsd: totalEquity - totalInitial,
      portfolioPnlPct: totalInitial > 0 ? ((totalEquity - totalInitial) / totalInitial) * 100 : 0,
      clonesReceived,
      creatorEarningsUsd: fromMicro(earnings.s),
    };
    return profile;
  });
}

/** season standings shaped like leaderboard rows (used by /api/leaderboard?window=season) */
export function seasonLeaderboardRows(app: AppContext) {
  const season = currentSeason(app.db);
  if (!season) return [];
  const markOf = (s: string) => app.executor.getMark(s);
  const summaries = botSummaries(app.db, markOf);
  const byId = new Map(summaries.map((b) => [b.id, b]));
  const standings = seasonStandings(app.db, season, (botId) => {
    const b = byId.get(botId);
    return b ? Math.round(b.equityUsd * 1_000_000) : 0;
  });
  return standings
    .filter((s) => byId.has(s.botId))
    .map((s, i) => {
      const b = byId.get(s.botId)!;
      return {
        rank: i + 1,
        botId: s.botId,
        name: b.name,
        kind: b.kind,
        ownerName: b.ownerName,
        pnlPct: s.pnlPct,
        pnlUsd: fromMicro(s.finalMicro - s.baselineMicro),
        winRate: b.tradeCount > 0 ? (b.winCount / Math.max(1, Math.round(b.tradeCount / 2))) * 100 : 0,
        tradeCount: b.tradeCount,
        maxDrawdownPct: 0,
        ageDays: (Date.now() - b.createdAt) / 86_400_000,
        rankDelta24h: undefined,
      };
    });
}
