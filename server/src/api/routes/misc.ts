import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { leaderboard } from '../queries.js';
import { requireUser } from './auth.js';
import { builderChat, type ChatMessage } from '../../toolkit/builderAgent.js';
import { validateStrategyConfig } from '../../toolkit/validator.js';
import { balanceMicro, ledgerFor } from '../../billing/ledger.js';
import { fromMicro } from '../../money.js';
import { approveEpoch, runEpoch } from '../../manager/managerAgent.js';
import { verifyChain } from '../../audit/auditLog.js';

const WINDOWS: Record<string, number | null> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  all: null,
};

export function registerMiscRoutes(server: FastifyInstance, app: AppContext) {
  const markOf = (s: string) => app.executor.getMark(s);

  // ── leaderboard ──
  server.get('/api/leaderboard', async (request) => {
    const { window } = z.object({ window: z.enum(['24h', '7d', 'all']).default('24h') }).parse(request.query);
    return { rows: leaderboard(app.db, markOf, WINDOWS[window]) };
  });

  // ── toolkit ──
  server.post('/api/toolkit/chat', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(40),
    }).parse(request.body);
    const turn = await builderChat(body.messages as ChatMessage[]);
    return turn;
  });

  server.post('/api/toolkit/validate', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({ config: z.unknown() }).parse(request.body);
    const result = validateStrategyConfig(body.config);
    return { valid: result.ok, errors: result.errors };
  });

  // ── billing ──
  server.get('/api/billing/balance', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    return {
      balanceUsd: fromMicro(balanceMicro(app.db, `user:${user.id}`)),
      platformUsd: user.isAdmin ? fromMicro(balanceMicro(app.db, 'platform')) : undefined,
    };
  });

  server.get('/api/billing/ledger', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const entries = (ledgerFor(app.db, `user:${user.id}`) as any[]).map((e) => ({
      id: e.id, ts: e.ts, type: e.type,
      amountUsd: fromMicro(e.amount_micro),
      debitAccount: e.debit_account, creditAccount: e.credit_account, memo: e.memo,
    }));
    return { entries };
  });

  // ── manager ──
  server.get('/api/manager/epochs', async () => {
    const epochs = (app.db
      .prepare(`SELECT * FROM payout_epochs ORDER BY id DESC LIMIT 50`)
      .all() as any[]).map(epochView(app));
    return { epochs };
  });

  server.get('/api/manager/epochs/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const epoch = app.db.prepare('SELECT * FROM payout_epochs WHERE id = ?').get(id) as any;
    if (!epoch) return reply.code(404).send({ error: 'epoch not found' });
    const items = (app.db
      .prepare('SELECT * FROM payout_items WHERE epoch_id = ? ORDER BY amount_micro DESC')
      .all(id) as any[]).map((i) => ({
        id: i.id, address: i.address, balance: i.balance,
        amountUsd: fromMicro(i.amount_micro), status: i.status, txSig: i.tx_sig,
      }));
    return { epoch: epochView(app)(epoch), items };
  });

  server.post('/api/manager/epochs/:id/approve', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'admin only' });
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    await approveEpoch(app.db, id, user.id, app.payoutQueue);
    app.hub.publish('manager', { event: 'epoch_approved', epochId: id });
    return { ok: true };
  });

  // manual epoch trigger (admin) — used for testing and demos
  server.post('/api/manager/epochs/run', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'admin only' });
    const result = await runEpoch(app.db, app.holderSource, app.payoutQueue);
    app.hub.publish('manager', { event: 'epoch_closed', epochId: result.epochId });
    return result;
  });

  server.get('/api/manager/audit', async () => {
    const rows = app.db
      .prepare('SELECT id, ts, actor, action, prev_hash, hash FROM audit_log ORDER BY id DESC LIMIT 100')
      .all();
    return { entries: rows, chain: verifyChain(app.db) };
  });

  // ── market ──
  server.get('/api/market/prices', async () => ({ prices: app.prices, feeds: app.feedStatus }));

  server.get('/api/market/candles', async (request) => {
    const q = z.object({
      symbol: z.string(),
      interval: z.enum(['1m', '5m', '15m', '1h']).default('5m'),
      limit: z.coerce.number().max(500).default(200),
    }).parse(request.query);
    return { candles: app.candles.history(q.symbol, q.interval, q.limit) };
  });

  server.get('/api/healthz', async () => ({ ok: true, ts: Date.now() }));
}

function epochView(app: AppContext) {
  return (e: any) => ({
    id: e.id,
    periodStart: e.period_start,
    periodEnd: e.period_end,
    totalProfitUsd: fromMicro(e.total_profit_micro),
    eligibleSupply: e.eligible_supply,
    eligibleHolders: (app.db
      .prepare('SELECT COUNT(*) AS n FROM payout_items WHERE epoch_id = ?')
      .get(e.id) as any).n,
    status: e.status,
    claudeSummary: e.claude_summary,
    anomalies: e.anomalies_json ? JSON.parse(e.anomalies_json) : null,
    createdAt: e.created_at,
  });
}
