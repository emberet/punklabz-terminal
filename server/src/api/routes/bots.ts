import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_BOTS_PER_USER, QUANT_INITIAL_BALANCE_USD, XP } from '@punklabz/shared';
import { awardXp } from '../../social/xp.js';
import { awardBadge, checkCloneBadges } from '../../social/badges.js';
import { emitActivity } from '../../social/activity.js';
import { botChat } from '../../toolkit/botChat.js';
import { rrProbability } from '../../analysis/rr.js';
import { applyPersonaToConfig, distillTraits, parsePersona, savePersona } from '../../toolkit/persona.js';
import { strategyConfigSchema } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { botSummaries } from '../queries.js';
import { requireUser } from './auth.js';
import { validateStrategyConfig } from '../../toolkit/validator.js';
import { chargeCreation, chargeReuse, InsufficientFunds } from '../../billing/ledger.js';
import { toMicro, fromMicro } from '../../money.js';
import { getOpenPositions } from '../../engine/accounting.js';

export function registerBotRoutes(server: FastifyInstance, app: AppContext) {
  const markOf = (s: string) => app.executor.getMark(s);

  server.get('/api/bots', async () => ({ bots: botSummaries(app.db, markOf) }));

  server.get('/api/bots/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const bot = botSummaries(app.db, markOf).find((b) => b.id === id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    const positions = getOpenPositions(app.db, id).map((p) => ({
      ...p,
      markPrice: markOf(p.symbol) ?? p.avgEntry,
      unrealizedPnlUsd: p.qty * ((markOf(p.symbol) ?? p.avgEntry) - p.avgEntry),
    }));
    const trades = app.db
      .prepare(
        `SELECT id, symbol, side, qty, price, fee_micro, realized_pnl_micro, ts, reason
         FROM trades WHERE bot_id = ? ORDER BY ts DESC LIMIT 100`,
      )
      .all(id)
      .map((t: any) => ({
        id: t.id, botId: id, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price,
        feeUsd: fromMicro(t.fee_micro), realizedPnlUsd: fromMicro(t.realized_pnl_micro), ts: t.ts,
        reason: t.reason ?? undefined,
      }));
    const metrics = app.db
      .prepare(`SELECT ts, equity_micro FROM bot_metrics WHERE bot_id = ? ORDER BY ts ASC LIMIT 2880`)
      .all(id)
      .map((m: any) => ({ ts: m.ts, equityUsd: fromMicro(m.equity_micro) }));
    const cfgRow = app.db.prepare('SELECT config_json, persona_json, owner_user_id FROM bots WHERE id = ?').get(id) as any;
    const persona = parsePersona(cfgRow.persona_json);
    let personaMods = null;
    if (persona && cfgRow.config_json && bot.strategyType === 'dsl') {
      const parsed = strategyConfigSchema.safeParse(JSON.parse(cfgRow.config_json));
      if (parsed.success) personaMods = applyPersonaToConfig(parsed.data, persona.traits).mods;
    }
    return { bot, positions, trades, metrics, config: JSON.parse(cfgRow.config_json), persona, personaMods };
  });

  // set/replace the agent's personality (owner only) — distilled once, applied at runtime
  server.post('/api/bots/:id/persona', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = z.object({ intro: z.string().min(10).max(1500) }).parse(request.body);
    const bot = app.db.prepare('SELECT owner_user_id, kind FROM bots WHERE id = ?').get(id) as any;
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    if (bot.kind !== 'quant' || (bot.owner_user_id !== user.id && !user.isAdmin))
      return reply.code(403).send({ error: 'only the owner can set a quant bot personality' });

    const traits = await distillTraits(body.intro, []);
    const persona = { intro: body.intro, notes: [], traits, updatedAt: Date.now() };
    savePersona(app.db, id, persona);
    app.engine.reloadBot(id);
    return { ok: true, persona };
  });

  // train the personality with a note — re-distills traits
  server.post('/api/bots/:id/persona/train', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = z.object({ note: z.string().min(3).max(300) }).parse(request.body);
    const bot = app.db.prepare('SELECT owner_user_id, kind, persona_json FROM bots WHERE id = ?').get(id) as any;
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    if (bot.kind !== 'quant' || (bot.owner_user_id !== user.id && !user.isAdmin))
      return reply.code(403).send({ error: 'only the owner can train this bot' });
    const existing = parsePersona(bot.persona_json);
    if (!existing) return reply.code(400).send({ error: 'set a personality first' });

    const notes = [...existing.notes, body.note].slice(-20);
    const traits = await distillTraits(existing.intro, notes);
    const persona = { ...existing, notes, traits, updatedAt: Date.now() };
    savePersona(app.db, id, persona);
    app.engine.reloadBot(id);
    return { ok: true, persona };
  });

  // deploy a quant bot from a validated DSL config — charges the $20 creation fee
  server.post('/api/bots', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({ config: z.unknown() }).parse(request.body);
    const result = validateStrategyConfig(body.config);
    if (!result.ok || !result.config) {
      return reply.code(400).send({ error: 'invalid config', details: result.errors });
    }
    const count = app.db
      .prepare(`SELECT COUNT(*) AS n FROM bots WHERE owner_user_id = ?`)
      .get(user.id) as { n: number };
    if (count.n >= MAX_BOTS_PER_USER)
      return reply.code(400).send({ error: `bot limit reached (${MAX_BOTS_PER_USER})` });

    try {
      const botId = app.db.transaction(() => {
        const info = app.db
          .prepare(
            `INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, status, created_at)
             VALUES (?, ?, 'quant', 'dsl', ?, 'running', ?)`,
          )
          .run(user.id, result.config!.name, JSON.stringify(result.config), Date.now());
        const id = Number(info.lastInsertRowid);
        app.db
          .prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, ?)`)
          .run(id, toMicro(QUANT_INITIAL_BALANCE_USD), toMicro(QUANT_INITIAL_BALANCE_USD), Date.now());
        chargeCreation(app.db, user.id, id);
        return id;
      })();
      app.engine.loadBots();
      awardXp(app.db, user.id, 'deploy', XP.deploy, botId);
      awardBadge(app.db, app.hub, user.id, 'first_deploy');
      emitActivity(app.db, app.hub, {
        type: 'deploy',
        actorUserId: user.id,
        botId,
        payload: { name: result.config.name },
      });
      return { ok: true, botId };
    } catch (e) {
      if (e instanceof InsufficientFunds)
        return reply.code(402).send({ error: 'insufficient balance for $20 creation fee' });
      throw e;
    }
  });

  // clone someone's bot — $10 to the original creator
  server.post('/api/bots/:id/clone', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const source = app.db
      .prepare(`SELECT id, owner_user_id, name, kind, strategy_type, config_json, is_public FROM bots WHERE id = ?`)
      .get(id) as any;
    if (!source) return reply.code(404).send({ error: 'bot not found' });
    if (source.kind !== 'quant' || !source.owner_user_id)
      return reply.code(400).send({ error: 'house bots cannot be cloned' });
    if (!source.is_public) return reply.code(403).send({ error: 'bot is private' });
    if (source.owner_user_id === user.id)
      return reply.code(400).send({ error: 'cannot clone your own bot' });
    const count = app.db
      .prepare(`SELECT COUNT(*) AS n FROM bots WHERE owner_user_id = ?`)
      .get(user.id) as { n: number };
    if (count.n >= MAX_BOTS_PER_USER)
      return reply.code(400).send({ error: `bot limit reached (${MAX_BOTS_PER_USER})` });

    try {
      const botId = app.db.transaction(() => {
        const info = app.db
          .prepare(
            `INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, cloned_from_bot_id, status, created_at)
             VALUES (?, ?, 'quant', 'dsl', ?, ?, 'running', ?)`,
          )
          .run(user.id, `${source.name} (clone)`, source.config_json, id, Date.now());
        const newId = Number(info.lastInsertRowid);
        app.db
          .prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, ?)`)
          .run(newId, toMicro(QUANT_INITIAL_BALANCE_USD), toMicro(QUANT_INITIAL_BALANCE_USD), Date.now());
        chargeReuse(app.db, user.id, source.owner_user_id, id);
        return newId;
      })();
      app.engine.loadBots();
      awardXp(app.db, source.owner_user_id, 'clone_received', XP.cloneReceived, botId);
      checkCloneBadges(app.db, app.hub, source.owner_user_id);
      emitActivity(app.db, app.hub, {
        type: 'clone',
        actorUserId: user.id,
        botId: id,
        payload: { newBotId: botId, creatorUserId: source.owner_user_id },
      });
      return { ok: true, botId };
    } catch (e) {
      if (e instanceof InsufficientFunds)
        return reply.code(402).send({ error: 'insufficient balance for $10 clone fee' });
      throw e;
    }
  });

  // chat with the agent — grounded on its live state
  server.post('/api/bots/:id/chat', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = z.object({
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) })).min(1).max(24),
    }).parse(request.body);
    const bot = app.db.prepare('SELECT id FROM bots WHERE id = ?').get(id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    return botChat({ db: app.db, candles: app.candles, markOf }, id, body.messages);
  });

  // playground: empirical RR probability from this bot's market history
  server.get('/api/bots/:id/rr', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const q = z.object({
      symbol: z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']).default('BTCUSDT'),
      stopPct: z.coerce.number().min(0.1).max(50),
      targetPct: z.coerce.number().min(0.1).max(200),
      leverage: z.coerce.number().min(1).max(25).default(1),
    }).parse(request.query);
    const bot = app.db.prepare('SELECT id FROM bots WHERE id = ?').get(id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    const candles = app.candles.history(q.symbol, '1m', 10_080); // up to 7d of 1m
    if (candles.length < 200)
      return reply.code(400).send({ error: 'not enough 1m history yet — try again in a few hours' });
    return rrProbability(candles, { stopPct: q.stopPct, targetPct: q.targetPct, leverage: q.leverage });
  });

  server.post('/api/bots/:id/start', async (request, reply) => botToggle(request, reply, 'running'));
  server.post('/api/bots/:id/stop', async (request, reply) => botToggle(request, reply, 'stopped'));

  async function botToggle(request: any, reply: any, status: 'running' | 'stopped') {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const bot = app.db.prepare('SELECT owner_user_id FROM bots WHERE id = ?').get(id) as any;
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    if (bot.owner_user_id !== user.id && !user.isAdmin)
      return reply.code(403).send({ error: 'not your bot' });
    app.db.prepare('UPDATE bots SET status = ? WHERE id = ?').run(status, id);
    app.engine.loadBots();
    return { ok: true };
  }
}
