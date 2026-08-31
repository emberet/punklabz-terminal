import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAPITAL_STAGES, type LiveStatusView } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { fromMicro } from '../../money.js';
import {
  getLiveConfig, haltNetwork, resumeNetwork, setCapitalStage, setLiveMode, stageCapUsd, updateLimits,
} from '../../live/riskEngine.js';
import { allInstruments, searchInstruments } from '../../live/instruments.js';

function requireAdmin(app: AppContext, request: any, reply: any) {
  const user = requireUser(app, request, reply);
  if (!user) return null;
  if (!user.isAdmin) {
    reply.code(403).send({ error: 'CONTROL ROOM clearance required' });
    return null;
  }
  return user;
}

export function registerLiveRoutes(server: FastifyInstance, app: AppContext) {
  server.get('/api/live/status', async (): Promise<LiveStatusView> => {
    const cfg = getLiveConfig(app.db);
    const stageCap = stageCapUsd(cfg.capitalStage);
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;

    const all = app.db
      .prepare(`SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s FROM live_ledger`)
      .get() as { s: number };
    const today = app.db
      .prepare(`SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s, COALESCE(SUM(fee_micro),0) f FROM live_ledger WHERE ts >= ?`)
      .get(dayStart) as { s: number; f: number };
    const deployed = app.db
      .prepare(`SELECT COALESCE(SUM(approved_notional_micro),0) s FROM live_orders WHERE state IN ('risk_approved','submitting','open','partial')`)
      .get() as { s: number };

    const rows = app.db.prepare(`SELECT realized_pnl_micro - fee_micro - gas_micro AS d FROM live_ledger ORDER BY ts ASC`).all() as { d: number }[];
    let cum = stageCap;
    let peak = stageCap;
    let dd = 0;
    for (const r of rows) {
      cum += fromMicro(r.d);
      peak = Math.max(peak, cum);
      if (peak > 0) dd = Math.max(dd, ((peak - cum) / peak) * 100);
    }

    const counts = app.db
      .prepare(
        `SELECT
           COUNT(*) AS signals,
           SUM(CASE WHEN state IN ('risk_approved','submitting','open','partial','filled') THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN state = 'filled' THEN 1 ELSE 0 END) AS executed,
           SUM(CASE WHEN state = 'risk_rejected' THEN 1 ELSE 0 END) AS rejected
         FROM live_orders WHERE created_at >= ?`,
      )
      .get(dayStart) as { signals: number; approved: number | null; executed: number | null; rejected: number | null };
    const pumpCount = app.db.prepare(`SELECT COUNT(*) n FROM pump_tokens`).get() as { n: number };

    const navUsd = stageCap + fromMicro(all.s);
    const deployedUsd = fromMicro(deployed.s);
    return {
      mode: cfg.mode,
      halted: cfg.halted,
      haltReason: cfg.haltReason,
      capitalStage: cfg.capitalStage,
      stageCapUsd: stageCap,
      limits: cfg.limits,
      nav: {
        totalUsd: navUsd,
        deployedUsd,
        availableUsd: Math.max(0, navUsd - deployedUsd),
        reserveUsd: (stageCap * cfg.limits.minCashReservePct) / 100,
      },
      today: { netPnlUsd: fromMicro(today.s), feesUsd: fromMicro(today.f), drawdownPct: dd },
      throughput: {
        marketsWatched: allInstruments().length + pumpCount.n,
        signals: counts.signals,
        approved: counts.approved ?? 0,
        executed: counts.executed ?? 0,
        rejected: counts.rejected ?? 0,
      },
      liveSignerConfigured: false, // structurally false in this build
    };
  });

  server.get('/api/live/orders', async (request) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(40) }).parse(request.query);
    const orders = (app.db
      .prepare(`SELECT * FROM live_orders ORDER BY id DESC LIMIT ?`)
      .all(q.limit) as any[]).map((o) => ({
        id: o.id,
        intentId: o.intent_id,
        botId: o.bot_id,
        instrumentId: o.instrument_id,
        venue: o.venue,
        side: o.side,
        requestedUsd: fromMicro(o.requested_notional_micro),
        approvedUsd: o.approved_notional_micro !== null ? fromMicro(o.approved_notional_micro) : null,
        mode: o.mode,
        state: o.state,
        confidence: o.confidence,
        risk: o.risk_json ? JSON.parse(o.risk_json) : null,
        expectedPrice: o.expected_price,
        executedPrice: o.executed_price,
        slippageBps: o.slippage_bps,
        feeUsd: fromMicro(o.fee_micro),
        rejectReason: o.reject_reason,
        ts: o.created_at,
      }));
    return { orders };
  });

  server.get('/api/live/venues', async () => {
    const rows = app.db.prepare(`SELECT * FROM venue_health ORDER BY venue`).all() as any[];
    return {
      venues: rows.map((r) => ({
        venue: r.venue, status: r.status, latencyMs: r.latency_ms,
        errorRate: r.error_rate, lastOkAt: r.last_ok_at, note: r.note,
      })),
    };
  });

  server.get('/api/live/instruments', async (request) => {
    const { q } = z.object({ q: z.string().max(40).default('') }).parse(request.query);
    return { instruments: searchInstruments(q), stages: CAPITAL_STAGES };
  });

  // ── operator controls (admin, audited; agents have no path to these) ──
  server.post('/api/live/mode', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ mode: z.enum(['simulation', 'shadow', 'canary', 'live']) }).parse(request.body);
    try {
      setLiveMode(app.db, body.mode, `admin:${user.id}`);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    app.hub.publish('live', { event: 'mode_change', mode: body.mode });
    return { ok: true, mode: body.mode };
  });

  server.post('/api/live/halt', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ reason: z.string().max(200).default('operator halt') }).parse(request.body ?? {});
    haltNetwork(app.db, body.reason, `admin:${user.id}`);
    app.hub.publish('live', { event: 'halted', reason: body.reason });
    return { ok: true };
  });

  server.post('/api/live/resume', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    resumeNetwork(app.db, `admin:${user.id}`);
    app.hub.publish('live', { event: 'resumed' });
    return { ok: true };
  });

  server.post('/api/live/limits', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({
      maxPerTradePct: z.number().min(0.5).max(10).optional(),
      maxPerMachinePct: z.number().min(1).max(30).optional(),
      maxSimultaneousPositions: z.number().int().min(1).max(10).optional(),
      maxDailyLossPct: z.number().min(1).max(10).optional(),
      maxTotalDrawdownPct: z.number().min(2).max(20).optional(),
      minCashReservePct: z.number().min(10).max(90).optional(),
      confidenceThreshold: z.number().int().min(50).max(100).optional(),
    }).parse(request.body);
    const limits = updateLimits(app.db, body, `admin:${user.id}`);
    return { ok: true, limits };
  });

  server.post('/api/live/stage', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ stage: z.number().int().min(0).max(4) }).parse(request.body);
    try {
      setCapitalStage(app.db, body.stage, `admin:${user.id}`);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    return { ok: true, stage: body.stage };
  });
}
