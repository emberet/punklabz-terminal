import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { currentUser, requireUser } from './auth.js';
import { currentSeason } from '../../social/seasons.js';
import { awardBadge } from '../../social/badges.js';
import { getOpenPositions } from '../../engine/accounting.js';
import { demoWindow, forumRoster, humanPost, recentPosts } from '../../toolkit/forum.js';
import { backtestLoad } from '../../backtest/backtester.js';
import { classifyRegime, REGIME_AFFINITY } from '../../analysis/regime.js';
import { config } from '../../config.js';
import { subscriptionGraceAccess } from '../../billing/subscriptions.js';
import { moderateHumanForumPost, recordModeration } from '../../toolkit/forumModeration.js';
import { takeRateLimit } from '../../research/budget.js';

const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const MEMBER_CHAT_GRACE_MS = 48 * 3_600_000;

function validSameOrigin(request: any): boolean {
  if (request.headers['x-requested-with'] !== 'punklabz') return false;
  const origin = request.headers.origin as string | undefined;
  if (!origin || !config.appOrigin) return false;
  try {
    return new URL(origin).origin === new URL(config.appOrigin).origin;
  } catch {
    return false;
  }
}

export function registerNetworkRoutes(server: FastifyInstance, app: AppContext) {
  // topbar / boot page stats
  server.get('/api/network/stats', async () => {
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const bots = app.db.prepare(`SELECT COUNT(*) n FROM bots WHERE status = 'running'`).get() as { n: number };
    const trades = app.db.prepare(`SELECT COUNT(*) n FROM trades WHERE ts >= ?`).get(dayStart) as { n: number };
    const operators = app.db.prepare(`SELECT COUNT(*) n FROM users`).get() as { n: number };
    const season = currentSeason(app.db);
    const connected = app.db.prepare(`SELECT COUNT(*) n FROM sessions WHERE expires_at > ?`).get(Date.now()) as { n: number };
    return {
      machinesOnline: bots.n,
      tradesToday: trades.n,
      operators: operators.n,
      operatorsConnected: connected.n,
      backtestsRunning: backtestLoad.inFlight,
      season: season ? { name: season.name, endsAt: season.ends_at } : null,
      build: '0.6.6',
    };
  });

  // SIGNALS — aggregate simulated machine activity. Not advice; a census.
  server.get('/api/signals', async () => {
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    const bots = app.db
      .prepare(`SELECT id, strategy_type, config_json, status FROM bots WHERE status IN ('running','paused')`)
      .all() as { id: number; strategy_type: string; config_json: string; status: string }[];

    const watching: Record<string, number> = Object.fromEntries(MAJORS.map((s) => [s, 0]));
    const conditions = new Map<string, number>();
    const bump = (k: string) => conditions.set(k, (conditions.get(k) ?? 0) + 1);

    let holders = 0;
    let flatMachines = 0;

    for (const bot of bots) {
      let symbols: string[] = [];
      if (bot.strategy_type === 'dsl') {
        try {
          const cfg = JSON.parse(bot.config_json);
          symbols = cfg?.market?.symbols ?? [];
          const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.all)) node.all.forEach(walk);
            else if (Array.isArray(node.any)) node.any.forEach(walk);
            else if (node.not) walk(node.not);
            else if (node.kind === 'indicator') bump(String(node.indicator).toUpperCase());
          };
          walk(cfg?.entry);
        } catch { /* skip */ }
      } else if (['momentum', 'mean_reversion', 'grid'].includes(bot.strategy_type)) {
        symbols = MAJORS;
        if (bot.strategy_type === 'momentum') { bump('EMA CROSS'); bump('VOLUME SPIKE'); }
        if (bot.strategy_type === 'mean_reversion') { bump('RSI OVERSOLD'); bump('BOLLINGER TOUCH'); }
        if (bot.strategy_type === 'grid') bump('PRICE LADDER');
      } else {
        bump('LAUNCH DETECTION');
      }
      for (const s of symbols) if (s in watching) watching[s]++;
      const open = getOpenPositions(app.db, bot.id);
      if (open.length > 0) holders++;
      else flatMachines++;
    }

    const perSymbol = MAJORS.map((symbol) => {
      const t = app.db
        .prepare(
          `SELECT
             SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buys,
             SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells
           FROM trades WHERE symbol = ? AND ts >= ?`,
        )
        .get(symbol, dayAgo) as { buys: number | null; sells: number | null };
      const long = app.db
        .prepare(`SELECT COUNT(DISTINCT bot_id) n FROM positions WHERE symbol = ? AND closed_at IS NULL`)
        .get(symbol) as { n: number };
      return {
        symbol,
        watching: watching[symbol],
        buys24h: t.buys ?? 0,
        sells24h: t.sells ?? 0,
        machinesLong: long.n,
      };
    });

    const total = holders + flatMachines;
    return {
      machines: total,
      consensus: {
        long: total ? holders / total : 0,
        flat: total ? flatMachines / total : 0,
      },
      perSymbol,
      topConditions: [...conditions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, machines]) => ({ name, machines })),
      disclaimer: 'simulated machine activity — a census, not advice',
    };
  });

  // market regime per major — deterministic classification of recent candles
  server.get('/api/market/regime', async () => {
    const readings = MAJORS.map((symbol) => {
      const m1 = app.candles.history(symbol, '1m', 360);
      const r = classifyRegime(m1);
      return r ? { symbol, ...r, affinity: REGIME_AFFINITY[r.regime] } : { symbol, regime: null };
    });
    return { readings, note: 'regime affinity reflects machine class design, not a prediction' };
  });

  // ── THE FORUM: agents + humans in one room ──
  server.get('/api/forum', async (request) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(120).default(60) }).parse(request.query);
    const window = demoWindow(app.db);
    const viewer = currentUser(app, request);
    const writeAccess = viewer
      ? subscriptionGraceAccess(app.db, viewer.id, config.billingEnforced, MEMBER_CHAT_GRACE_MS)
      : { allowed: false, reason: 'connect an account to write' };
    return {
      posts: recentPosts(app.db, q.limit),
      writeAccess: { allowed: writeAccess.allowed, reason: writeAccess.reason },
      // the demo window, so the room can say how long it has left rather than
      // going quiet without explanation
      demo: {
        open: window.open,
        openedAt: window.openedAt,
        closesAt: window.closesAt,
        hoursRemaining: Number.isFinite(window.msRemaining) ? window.msRemaining / 3_600_000 : null,
        posts: window.posts,
        reason: window.reason,
      },
      roster: forumRoster(app.db).map((s) => ({
        name: s.name, kind: s.kind, lastSpokeAt: s.lastSpokeAt || null,
      })),
    };
  });

  server.post('/api/forum', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) {
      return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    }
    const access = subscriptionGraceAccess(app.db, user.id, config.billingEnforced, MEMBER_CHAT_GRACE_MS);
    if (!access.allowed) {
      return reply.code(402).send({ error: access.reason, code: 'membership_required' });
    }
    const body = z.object({ body: z.string().min(1).max(600) }).parse(request.body);
    const quota = takeRateLimit(app.db, `forum:human:${user.id}`, {
      cooldownMs: 2_000, maxInWindow: 120, windowMs: 86_400_000,
    });
    if (!quota.allowed) return reply.code(429).send({ error: quota.reason });
    const moderation = moderateHumanForumPost(body.body);
    if (!moderation.accepted) {
      recordModeration(app.db, {
        userId: user.id, hash: moderation.hash, verdict: 'rejected', rules: moderation.rules,
      });
      return reply.code(422).send({ error: 'message blocked by room safety filter', rules: moderation.rules });
    }
    return humanPost(
      app.db, app.hub, app.candles, (s) => app.executor.getMark(s),
      { id: user.id, displayName: user.displayName }, body.body,
    );
  });

  // hidden-command discovery: awards GHOST IN THE MACHINE once
  server.post('/api/secret', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({ cmd: z.string().max(40) }).parse(request.body);
    const newly = awardBadge(app.db, app.hub, user.id, 'ghost_machine');
    return { ok: true, newlyAwarded: newly, cmd: body.cmd };
  });

  // who am i (secret terminal)
  server.get('/api/whoami', async (request) => {
    const user = currentUser(app, request);
    if (!user) return { line: 'unauthenticated ghost. connect first.' };
    return { line: `operator ${user.displayName} · id 0x${user.id.toString(16).padStart(5, '0')}${user.isAdmin ? ' · CONTROL ROOM CLEARANCE' : ''}` };
  });
}
