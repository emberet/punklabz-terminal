import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAPITAL_STAGES, ROBINHOOD_MAINNET_CHAIN_ID, type LiveStatusView } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { fromMicro } from '../../money.js';
import {
  getLiveConfig, haltNetwork, promotionEvidence, resumeNetwork, setCapitalStage,
  setLiveMode, stageCapUsd, updateLimits,
} from '../../live/riskEngine.js';
import { ROBINHOOD_VENUE, SETTLEMENT, allInstruments, searchInstruments } from '../../live/instruments.js';
import { runPreflight, preflightLines } from '../../live/preflight.js';
import { accountBook, accountForMode, listAccounts } from '../../live/accounts.js';
import { reconcileAll } from '../../live/reconciler.js';
import { mappedSymbols } from '../../live/instrumentResolver.js';
import { buildResearchExport } from '../../research/export.js';
import { closeNow, currentWindow, openWindow } from '../../research/window.js';

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

    // NAV/drawdown are scoped to the account this mode books to — shadow P&L
    // never leaks into a live account's figures
    const account = accountForMode(app.db, cfg.mode);
    const book = accountBook(app.db, account.id, stageCap);

    const counts = app.db
      .prepare(
        `SELECT
           COUNT(*) AS signals,
           SUM(CASE WHEN state IN ('risk_approved','submitting','open','partial','filled') THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN state = 'filled' THEN 1 ELSE 0 END) AS executed,
           SUM(CASE WHEN state = 'risk_rejected' THEN 1 ELSE 0 END) AS rejected
         FROM live_orders WHERE created_at >= ? AND execution_account_id = ?`,
      )
      .get(dayStart, account.id) as { signals: number; approved: number | null; executed: number | null; rejected: number | null };
    const pumpCount = app.db.prepare(`SELECT COUNT(*) n FROM pump_tokens`).get() as { n: number };

    const signerReady = await app.signer.isReady();
    return {
      mode: cfg.mode,
      halted: cfg.halted,
      haltReason: cfg.haltReason,
      capitalStage: cfg.capitalStage,
      stageCapUsd: stageCap,
      limits: cfg.limits,
      nav: {
        totalUsd: book.navUsd,
        deployedUsd: book.deployedUsd,
        availableUsd: Math.max(0, book.navUsd - book.deployedUsd),
        reserveUsd: (stageCap * cfg.limits.minCashReservePct) / 100,
      },
      today: { netPnlUsd: book.todayPnlUsd, feesUsd: book.feesUsd, drawdownPct: book.drawdownPct },
      throughput: {
        marketsWatched: allInstruments().length + pumpCount.n,
        signals: counts.signals,
        approved: counts.approved ?? 0,
        executed: counts.executed ?? 0,
        rejected: counts.rejected ?? 0,
      },
      liveSignerConfigured: signerReady.ready, // reported, never asserted

      // ── the execution boundary, as it actually is right now ──
      // Every field is measured at request time. Nothing here is a config
      // value echoed back: `signerReady` is a live round trip to the signing
      // service, `adapter` is a real health probe, and the balances come off
      // the chain rather than out of our own ledger.
      network: 'robinhood',
      chainId: ROBINHOOD_MAINNET_CHAIN_ID,
      settlementSymbol: SETTLEMENT.symbol,
      signer: {
        kind: app.signer.kind,
        ready: signerReady.ready,
        address: signerReady.address,
        detail: signerReady.detail,
      },
      walletAddress: signerReady.address,
      ...(await executionBoundary(app)),
    };
  });

  /**
   * Adapter health, wallet balances and the last reconciliation — the things
   * an operator needs before deciding whether canary is safe to arm.
   * Deliberately tolerant: a probe that fails reports the failure rather than
   * throwing and taking the whole status endpoint down with it.
   */
  async function executionBoundary(app: AppContext) {
    const adapter = app.adapters.get(ROBINHOOD_VENUE);
    let adapterStatus = 'not registered';
    let settlementBalance: number | null = null;
    let ethGasBalance: number | null = null;

    if (adapter) {
      try {
        const health = await adapter.health();
        adapterStatus = `${health.status}${health.note ? ` — ${health.note}` : ''}`;
      } catch (e) {
        adapterStatus = `probe failed: ${String(e).slice(0, 80)}`;
      }
      if (typeof adapter.getBalances === 'function') {
        try {
          const balances = await adapter.getBalances();
          settlementBalance = balances.find((b) => b.asset.toUpperCase() === SETTLEMENT.symbol.toUpperCase())?.qty ?? 0;
          ethGasBalance = balances.find((b) => b.asset.toUpperCase() === 'ETH')?.qty ?? 0;
        } catch {
          // leave null: "we could not read it" is not the same as "it is zero"
        }
      }
    }

    const recon = app.db
      .prepare(`SELECT ts, within_tolerance FROM balance_snapshots ORDER BY id DESC LIMIT 1`)
      .get() as { ts: number; within_tolerance: number } | undefined;
    const preflight = app.db
      .prepare(`SELECT ts, target_mode, passed FROM preflight_runs ORDER BY id DESC LIMIT 1`)
      .get() as { ts: number; target_mode: string; passed: number } | undefined;

    return {
      adapterStatus,
      settlementBalance,
      ethGasBalance,
      lastReconciliation: recon
        ? { at: recon.ts, clean: recon.within_tolerance === 1 }
        : null,
      preflightStatus: preflight
        ? { at: preflight.ts, mode: preflight.target_mode, passed: preflight.passed === 1 }
        : null,
    };
  }

  /**
   * The research record. Admin-only: it is one operator's trading history,
   * including wallet-linked transaction references, and it is not public data.
   */
  server.get('/api/live/research', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    return buildResearchExport(app.db);
  });

  /** Open / inspect / close the research window. */
  server.get('/api/live/window', async () => currentWindow(app.db));

  server.post('/api/live/window', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({
      hours: z.number().min(0.5).max(168),
      confidenceThreshold: z.number().int().min(50).max(100),
      maxSimultaneousPositions: z.number().int().min(1).max(10),
      maxPerTradePct: z.number().min(0.5).max(10),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    try {
      return openWindow(app.db, { ...body.data, actor: `user:${user.id}` });
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  server.delete('/api/live/window', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    return closeNow(app.db, `user:${user.id}`);
  });

  // GLOBAL PROCESS: the funnel, every number measured
  server.get('/api/live/process', async () => {
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const hourAgo = Date.now() - 3_600_000;

    const lastPass = app.db.prepare(`SELECT * FROM scan_passes ORDER BY id DESC LIMIT 1`).get() as any;
    const window = app.db
      .prepare(
        `SELECT COALESCE(SUM(markets_observed),0) obs, COALESCE(SUM(candidates),0) c,
                COALESCE(SUM(signals),0) s, COALESCE(SUM(high_confidence),0) h,
                COUNT(*) passes, COALESCE(AVG(duration_ms),0) avg_ms,
                COALESCE(MAX(markets_observed),0) universe
         FROM scan_passes WHERE ts >= ?`,
      )
      .get(hourAgo) as any;
    const rejected = app.db
      .prepare(`SELECT COUNT(*) n FROM opportunities WHERE state = 'rejected' AND ts >= ?`)
      .get(hourAgo) as { n: number };
    const orders = app.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state IN ('risk_approved','submitting','open','partial','filled') THEN 1 ELSE 0 END) approved,
           SUM(CASE WHEN state IN ('submitting','open','partial','filled') THEN 1 ELSE 0 END) routed,
           SUM(CASE WHEN state = 'filled' THEN 1 ELSE 0 END) executed
         FROM live_orders WHERE created_at >= ?`,
      )
      .get(dayStart) as any;

    return {
      live: app.opportunities?.counts() ?? null,
      lastPass: lastPass
        ? { ts: lastPass.ts, durationMs: lastPass.duration_ms, marketsObserved: lastPass.markets_observed, scansPerformed: lastPass.scans_performed }
        : null,
      universeSize: window.universe,
      funnel: {
        marketsObserved: window.obs,
        candidates: window.c,
        signals: window.s,
        highConfidence: window.h,
        riskApproved: orders.approved ?? 0,
        routed: orders.routed ?? 0,
        executed: orders.executed ?? 0,
        rejectedOnEdge: rejected.n,
      },
      passesLastHour: window.passes,
      avgPassMs: Math.round(window.avg_ms),
      note: 'scanner opportunities are advisory — only a machine committing capital reaches execution',
    };
  });

  // recent opportunities with their full edge math
  server.get('/api/live/opportunities', async (request) => {
    const q = z.object({
      limit: z.coerce.number().min(1).max(80).default(30),
      state: z.enum(['all', 'high_confidence', 'rejected']).default('all'),
    }).parse(request.query);
    const where = q.state === 'all' ? '' : `WHERE state = '${q.state}'`;
    const rows = app.db
      .prepare(`SELECT * FROM opportunities ${where} ORDER BY id DESC LIMIT ?`)
      .all(q.limit) as any[];
    return {
      opportunities: rows.map((o) => ({
        id: o.id, ts: o.ts, scanner: o.scanner, universe: o.universe,
        symbol: o.symbol, direction: o.direction, confidence: o.confidence,
        edge: {
          grossEdgeBps: o.gross_edge_bps, feeBps: o.fee_bps, slippageBps: o.slippage_bps,
          bufferBps: o.buffer_bps, netEdgeBps: o.net_edge_bps, edgeModel: o.edge_model,
        },
        evidence: JSON.parse(o.evidence_json),
        state: o.state, rejectReason: o.reject_reason, advisory: o.advisory === 1,
      })),
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

  // dry-run the gate for any mode without changing anything
  server.get('/api/live/preflight', async (request) => {
    const q = z.object({
      mode: z.enum(['simulation', 'shadow', 'canary', 'live']).default('live'),
    }).parse(request.query);
    const result = await runPreflight(
      { db: app.db, signer: app.signer, adapters: app.adapters, feedStatus: app.feedStatus,
        ethUsd: app.executor.getMark('ETHUSDT') ?? null },
      q.mode,
      'dry-run',
    );
    return { ...result, lines: preflightLines(result), mappedSymbols: mappedSymbols() };
  });

  server.get('/api/live/accounts', async () => {
    const cfg = getLiveConfig(app.db);
    const stageCap = stageCapUsd(cfg.capitalStage);
    return {
      accounts: listAccounts(app.db).map((a) => ({
        ...a,
        book: accountBook(app.db, a.id, a.mode === cfg.mode ? stageCap : a.fundedUsd),
      })),
      promotion: promotionEvidence(app.db),
    };
  });

  server.post('/api/live/reconcile', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    return { passes: await reconcileAll(app.db, app.hub, app.adapters) };
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
    const preflight = await runPreflight(
      { db: app.db, signer: app.signer, adapters: app.adapters, feedStatus: app.feedStatus,
        ethUsd: app.executor.getMark('ETHUSDT') ?? null },
      body.mode,
      `admin:${user.id}`,
    );
    try {
      setLiveMode(app.db, body.mode, `admin:${user.id}`, preflight);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message, preflight });
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
    const body = z.object({
      stage: z.number().int().min(0).max(4),
      force: z.boolean().optional(),
    }).parse(request.body);
    try {
      setCapitalStage(app.db, body.stage, `admin:${user.id}`, body.force ?? false);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    return { ok: true, stage: body.stage };
  });
}
