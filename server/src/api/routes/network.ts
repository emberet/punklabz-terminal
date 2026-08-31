import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { currentUser, requireUser } from './auth.js';
import { currentSeason } from '../../social/seasons.js';
import { awardBadge } from '../../social/badges.js';
import { getOpenPositions } from '../../engine/accounting.js';

const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

export function registerNetworkRoutes(server: FastifyInstance, app: AppContext) {
  // topbar / boot page stats
  server.get('/api/network/stats', async () => {
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const bots = app.db.prepare(`SELECT COUNT(*) n FROM bots WHERE status = 'running'`).get() as { n: number };
    const trades = app.db.prepare(`SELECT COUNT(*) n FROM trades WHERE ts >= ?`).get(dayStart) as { n: number };
    const operators = app.db.prepare(`SELECT COUNT(*) n FROM users`).get() as { n: number };
    const season = currentSeason(app.db);
    return {
      machinesOnline: bots.n,
      tradesToday: trades.n,
      operators: operators.n,
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
