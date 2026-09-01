import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recoverMessageAddress } from 'viem';
import { CAPITAL_STAGES, ROBINHOOD_MAINNET_CHAIN_ID, type LiveStatusView } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { fromMicro } from '../../money.js';
import {
  getLiveConfig, haltNetwork, promotionEvidence, setCapitalStage,
  setLiveMode, stageCapUsd, updateLimits,
} from '../../live/riskEngine.js';
import { ROBINHOOD_VENUE, SETTLEMENT, allInstruments, searchInstruments } from '../../live/instruments.js';
import { runPreflight, preflightLines } from '../../live/preflight.js';
import {
  accountBook, accountForMode, custodyHoldings, listAccounts, recordFunding, setBotAllocation,
} from '../../live/accounts.js';
import { reconcileAll } from '../../live/reconciler.js';
import { mappedSymbols, resolveLiveInstrument } from '../../live/instrumentResolver.js';
import { buildResearchExport } from '../../research/export.js';
import { closeNow, currentWindow, openWindow } from '../../research/window.js';
import { activeUniverse, activateUniverseSnapshot, createUniverseSnapshot, universeAssets } from '../../robinhood/universe.js';
import { FullPairScanner } from '../../live/pairScanner.js';
import { councilBudgetStatus, runTradingCouncil } from '../../live/tradingCouncil.js';
import {
  generateUniversePolicyBundle, recordAppliedUniversePolicy, verifyActiveUniversePolicy,
} from '../../live/signing/universePolicy.js';
import { enableFullMarketAutonomy, fullMarketReadiness } from '../../live/fullMarketController.js';
import { config } from '../../config.js';

const JURISDICTION_VERSION = 'rh-stock-token-v1';

function jurisdictionMessage(wallet: string, timestamp: number): string {
  return [
    'PunkLabz Stock Token Jurisdiction Attestation v1',
    `Wallet: ${wallet.toLowerCase()}`,
    'I attest that I am not a U.S. person and that this execution account is not controlled from a restricted jurisdiction.',
    `Timestamp: ${timestamp}`,
  ].join('\n');
}

function requireAdmin(app: AppContext, request: any, reply: any) {
  const user = requireUser(app, request, reply);
  if (!user) return null;
  if (!user.isAdmin) {
    reply.code(403).send({ error: 'CONTROL ROOM clearance required' });
    return null;
  }
  return user;
}

function requireFreshAdmin(app: AppContext, request: any, reply: any) {
  const user = requireAdmin(app, request, reply);
  if (!user) return null;
  if (user.sessionAuthMethod !== 'wallet' || Date.now() - user.sessionCreatedAt > 5 * 60_000) {
    reply.code(401).send({ error: 'fresh operator wallet authentication required' });
    return null;
  }
  if (request.headers['x-requested-with'] !== 'punklabz') {
    reply.code(403).send({ error: 'CSRF protection header missing' });
    return null;
  }
  const origin = request.headers.origin as string | undefined;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        reply.code(403).send({ error: 'request origin does not match host' });
        return null;
      }
    } catch {
      reply.code(403).send({ error: 'invalid request origin' });
      return null;
    }
  }
  return user;
}

export function registerLiveRoutes(server: FastifyInstance, app: AppContext) {
  const fullMarketView = () => {
    const universe = activeUniverse(app.db);
    const sweep = universe ? app.db.prepare(
      `SELECT * FROM pair_sweep_runs WHERE snapshot_id=? ORDER BY id DESC LIMIT 1`,
    ).get(universe.id) as any : null;
    const budget = councilBudgetStatus(app.db);
    const cfg = app.db.prepare(
      `SELECT full_market_autonomy, autonomy_enabled, halted, authorized_capital_usdg,
              expected_signer_policy_hash, observed_signer_policy_hash FROM live_config WHERE id=1`,
    ).get() as any;
    return {
      enabled: config.fullMarketScannerEnabled
        && cfg.full_market_autonomy === 1 && cfg.autonomy_enabled === 1 && cfg.halted === 0,
      scannerEnabled: config.fullMarketScannerEnabled,
      snapshotHash: universe?.contentHash ?? null,
      assetCount: universe?.assetCount ?? 0,
      directedPairCount: universe?.directedPairCount ?? 0,
      eligiblePairs: sweep?.eligible_pairs ?? 0,
      blockedPairs: sweep?.rejected_pairs ?? 0,
      sweepState: sweep?.state ?? null,
      sweepCompletedAt: sweep?.completed_at ?? null,
      councilSpentUsd: budget.spentUsd,
      councilCapUsd: budget.capUsd,
      policyReady: !!cfg.expected_signer_policy_hash
        && cfg.expected_signer_policy_hash === cfg.observed_signer_policy_hash,
      authorizedCapitalUsdg: cfg.authorized_capital_usdg === null ? null : Number(cfg.authorized_capital_usdg),
    };
  };
  const detailedStatus = async (): Promise<LiveStatusView> => {
    const cfg = getLiveConfig(app.db);
    const stageCap = stageCapUsd(cfg.capitalStage);
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;

    // NAV/drawdown are scoped to the account this mode books to — shadow P&L
    // never leaks into a live account's figures
    const account = accountForMode(app.db, cfg.mode);
    const traderAccount = accountForMode(app.db, 'canary', ROBINHOOD_VENUE);
    const book = accountBook(app.db, traderAccount.id, stageCap);
    const boundary = await executionBoundary(app);
    let wethMark = 0;
    if (boundary.baseAssetBalance !== null && boundary.baseAssetBalance > 0) {
      const resolved = resolveLiveInstrument('ETHUSDT');
      const adapter = app.adapters.get(ROBINHOOD_VENUE);
      try {
        const liquidation = resolved.instrument && adapter?.getExecutableSellQuote
          ? await adapter.getExecutableSellQuote(resolved.instrument, boundary.baseAssetBalance)
          : null;
        wethMark = liquidation?.price ?? 0;
      } catch {
        // Unliquidatable exposure contributes zero to authorized NAV.
        wethMark = 0;
      }
    }
    let walletNav = boundary.settlementBalance !== null && boundary.baseAssetBalance !== null
      ? boundary.settlementBalance + boundary.baseAssetBalance * wethMark
      : 0;
    let deployedHoldings = (boundary.baseAssetBalance ?? 0) * wethMark;
    const navAdapter = app.adapters.get(ROBINHOOD_VENUE);
    if (activeUniverse(app.db) && traderAccount.walletAddress && navAdapter?.getConservativeNav) {
      const conservative = await navAdapter.getConservativeNav(traderAccount.walletAddress).catch(() => null);
      if (conservative?.ok) {
        walletNav = conservative.totalUsd;
        deployedHoldings = conservative.holdings.reduce((sum, holding) => sum + holding.liquidationUsd, 0);
      } else {
        // Unpriced or unexitable holdings make authorized NAV zero, not optimistic.
        walletNav = 0;
        deployedHoldings = 0;
      }
    }
    const captured = (app.db.prepare(`SELECT authorized_capital_usdg cap FROM live_config WHERE id=1`).get() as any)?.cap;
    const authorizedCapital = Math.min(stageCap, captured === null ? stageCap : Number(captured), walletNav);
    const deployed = deployedHoldings + book.deployedUsd;
    const reserve = (authorizedCapital * cfg.limits.minCashReservePct) / 100;
    const available = Math.max(0, Math.min(boundary.settlementBalance ?? 0, authorizedCapital - deployed - reserve));

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
      phase: cfg.phase,
      autonomyEnabled: cfg.autonomyEnabled,
      halted: cfg.halted,
      haltReason: cfg.haltReason,
      capitalStage: cfg.capitalStage,
      stageCapUsd: stageCap,
      limits: cfg.limits,
      nav: {
        totalUsd: walletNav,
        deployedUsd: deployed,
        availableUsd: available,
        reserveUsd: reserve,
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
      authorizedCapitalUsd: authorizedCapital,
      promotion: promotionEvidence(app.db),
      experiment: app.canaryExperiment?.latest() ?? null,
      fullMarket: {
        ...fullMarketView(),
        policyReady: activeUniverse(app.db)
          ? (await verifyActiveUniversePolicy(app.db, app.signer)).ok
          : false,
      },
      ...boundary,
    };
  };

  server.get('/api/live/status', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => {
    // Public polling never calls Privy, 0x, or the RPC. It serves coarse state
    // plus delayed aggregates from local records, so it cannot be used to burn
    // provider quotas or inspect the execution wallet by timing responses.
    const cfg = getLiveConfig(app.db);
    const stageCap = stageCapUsd(cfg.capitalStage);
    const cutoff = Date.now() - 15 * 60_000;
    const dayStart = Math.floor(cutoff / 86_400_000) * 86_400_000;
    const trader = app.db.prepare(`SELECT id FROM execution_accounts WHERE name='ROBINHOOD_TRADER_01'`)
      .get() as { id: number } | undefined;
    const delayed = trader ? app.db.prepare(
      `SELECT COALESCE(SUM(realized_pnl_micro-fee_micro-gas_micro),0) pnl,
              COALESCE(SUM(fee_micro+gas_micro),0) fees,
              COUNT(*) fills
       FROM live_ledger WHERE execution_account_id=? AND ts BETWEEN ? AND ?`,
    ).get(trader.id, dayStart, cutoff) as { pnl: number; fees: number; fills: number }
      : { pnl: 0, fees: 0, fills: 0 };
    const venue = app.db.prepare(
      `SELECT status FROM venue_health WHERE venue=? ORDER BY updated_at DESC LIMIT 1`,
    ).get(ROBINHOOD_VENUE) as { status: string } | undefined;
    return {
      mode: cfg.mode,
      phase: cfg.phase,
      autonomyEnabled: cfg.autonomyEnabled,
      halted: cfg.halted,
      haltReason: cfg.halted ? 'operator attention required' : null,
      capitalStage: cfg.capitalStage,
      stageCapUsd: stageCap,
      network: 'robinhood',
      chainId: ROBINHOOD_MAINNET_CHAIN_ID,
      settlementSymbol: SETTLEMENT.symbol,
      authorizedCapitalUsd: stageCap,
      nav: {
        totalUsd: stageCap,
        deployedUsd: 0,
        availableUsd: 0,
        reserveUsd: 0,
      },
      today: {
        netPnlUsd: fromMicro(delayed.pnl), feesUsd: fromMicro(delayed.fees), drawdownPct: 0,
      },
      throughput: {
        marketsWatched: allInstruments().length,
        signals: 0, approved: 0, executed: delayed.fills, rejected: 0,
      },
      adapterStatus: venue?.status === 'online' ? 'online' : 'unavailable',
      fullMarket: fullMarketView(),
      delayedAsOf: cutoff,
    };
  });

  server.get('/api/admin/live/status', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    return detailedStatus();
  });

  server.get('/api/live/universe', async () => {
    const universe = activeUniverse(app.db);
    return {
      chainId: 4663,
      symbols: universe ? universeAssets(app.db, universe.id).map((asset) => asset.symbol) : [],
      assetCount: universe?.assetCount ?? 0,
      directedPairCount: universe?.directedPairCount ?? 0,
      health: fullMarketView().sweepState ?? 'not_configured',
    };
  });

  server.get('/api/admin/live/universe', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    const active = activeUniverse(app.db);
    const snapshots = app.db.prepare(`SELECT * FROM rh_universe_snapshots ORDER BY id DESC LIMIT 20`).all();
    return { active, assets: active ? universeAssets(app.db, active.id) : [], snapshots, status: fullMarketView() };
  });

  server.post('/api/admin/live/universe/snapshot', { config: { rateLimit: { max: 2, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    try { return { ok: true, snapshot: createUniverseSnapshot(app.db, `admin:${user.id}`) }; }
    catch (error) { return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) }); }
  });

  server.post('/api/admin/live/universe/activate', { config: { rateLimit: { max: 2, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ snapshotId: z.number().int().positive(), confirmation: z.literal('ACTIVATE VERIFIED UNIVERSE') }).parse(request.body);
    try { return { ok: true, snapshot: activateUniverseSnapshot(app.db, body.snapshotId, `admin:${user.id}`) }; }
    catch (error) { return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) }); }
  });

  server.get('/api/admin/live/jurisdiction/message', async (request, reply) => {
    const user = requireAdmin(app, request, reply);
    if (!user) return;
    if (!user.walletAddress) return reply.code(409).send({ error: 'operator account has no wallet' });
    const timestamp = Date.now();
    return { version: JURISDICTION_VERSION, timestamp, message: jurisdictionMessage(user.walletAddress, timestamp) };
  });

  server.post('/api/admin/live/jurisdiction/attest', { config: { rateLimit: { max: 2, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    if (!user.walletAddress) return reply.code(409).send({ error: 'operator account has no wallet' });
    const body = z.object({ timestamp: z.number().int(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(request.body);
    if (Math.abs(Date.now() - body.timestamp) > 5 * 60_000) return reply.code(400).send({ error: 'attestation timestamp is stale' });
    const message = jurisdictionMessage(user.walletAddress, body.timestamp);
    const recovered = await recoverMessageAddress({ message, signature: body.signature as `0x${string}` }).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== user.walletAddress.toLowerCase()) {
      return reply.code(401).send({ error: 'attestation signature does not match the operator wallet' });
    }
    app.db.prepare(
      `INSERT INTO operator_jurisdiction_attestations
       (wallet_address, statement_version, not_us_person, not_restricted_jurisdiction,
        signature, signed_message, actor, attested_at)
       VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
    ).run(user.walletAddress.toLowerCase(), JURISDICTION_VERSION, body.signature, message, `admin:${user.id}`, Date.now());
    return { ok: true, version: JURISDICTION_VERSION, attestedAt: Date.now() };
  });

  server.post('/api/admin/live/universe/policy/generate', { config: { rateLimit: { max: 1, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ confirmation: z.literal('GENERATE SNAPSHOT POLICY') }).parse(request.body);
    try { return { ok: true, bundle: generateUniversePolicyBundle(app.db) }; }
    catch (error) { return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) }); }
  });

  server.post('/api/admin/live/universe/policy/confirm', { config: { rateLimit: { max: 2, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ policyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      policyIds: z.array(z.string().min(4).max(200)).min(1).max(20) }).parse(request.body);
    await app.signer.isReady();
    const observed = app.signer.guards?.().policyIds ?? [];
    try {
      if (!app.signer.getPolicyBodies) throw new Error('configured signer cannot read back policy bodies');
      const policyBodies = await app.signer.getPolicyBodies(body.policyIds);
      recordAppliedUniversePolicy(app.db, body.policyHash, body.policyIds, observed, policyBodies, `admin:${user.id}`);
      return { ok: true, observedPolicyIds: observed };
    } catch (error) { return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) }); }
  });

  server.post('/api/admin/live/sweep', { config: { rateLimit: { max: 1, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    try { return { ok: true, sweep: await new FullPairScanner(app.db, {
      ethUsd: app.executor.getMark('ETHUSDT') ?? 0,
    }).run() }; }
    catch (error) { return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) }); }
  });

  server.get('/api/admin/live/sweeps', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    return { sweeps: app.db.prepare(`SELECT * FROM pair_sweep_runs ORDER BY id DESC LIMIT 20`).all(),
      councilBudget: councilBudgetStatus(app.db) };
  });

  server.get('/api/admin/live/candidates', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    const sweepId = Number((request.query as any)?.sweepId);
    if (!Number.isInteger(sweepId) || sweepId <= 0) return reply.code(400).send({ error: 'sweepId is required' });
    return { candidates: app.db.prepare(
      `SELECT id, sell_symbol, buy_symbol, source_value_micro, reference_edge_bps,
              rejection_code, rejection_detail, rank_score, created_at
       FROM pair_sweep_candidates WHERE sweep_id=? ORDER BY CAST(rank_score AS REAL) DESC LIMIT 500`,
    ).all(sweepId) };
  });

  server.post('/api/admin/live/council/run', { config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ sweepId: z.number().int().positive() }).parse(request.body);
    const sources = app.newsFeed.snapshot().map((item, index) => ({ id: `news:${item.source}:${item.ts}:${index}`,
      title: item.title, url: item.link, source: item.source, ts: item.ts }));
    return { ok: true, council: await runTradingCouncil(app.db, body.sweepId, sources) };
  });

  server.get('/api/admin/live/full-market/readiness', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    return fullMarketReadiness(app.db, app.signer);
  });

  server.post('/api/admin/live/full-market/enable', { config: { rateLimit: { max: 1, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ confirmation: z.literal('ENABLE AUTONOMOUS CANARY $5') }).parse(request.body);
    const preflight = await runPreflight({ db: app.db, signer: app.signer, adapters: app.adapters,
      feedStatus: app.feedStatus, ethUsd: app.executor.getMark('ETHUSDT') ?? null }, 'canary', `admin:${user.id}`);
    if (!preflight.passed) return reply.code(409).send({ error: `preflight blocked: ${preflight.blockers.join('; ')}` });
    try { return { ok: true, readiness: await enableFullMarketAutonomy(app.db, app.signer, body.confirmation, `admin:${user.id}`) }; }
    catch (error) { return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) }); }
  });

  server.post('/api/admin/live/full-market/cycle', { config: { rateLimit: { max: 1, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    z.object({ confirmation: z.literal('RUN AUTONOMOUS CYCLE') }).parse(request.body);
    if (!app.fullMarketAutonomy) return reply.code(503).send({ error: 'full-market scheduler is unavailable' });
    return app.fullMarketAutonomy.cycle();
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
    let baseAssetBalance: number | null = null;

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
          baseAssetBalance = balances.find((b) => b.asset.toUpperCase() === 'WETH')?.qty ?? 0;
        } catch {
          // leave null: "we could not read it" is not the same as "it is zero"
        }
      }
    }

    const trader = accountForMode(app.db, 'canary', ROBINHOOD_VENUE);
    const recon = app.db
      .prepare(`SELECT completed_at ts, status FROM reconciliation_runs WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`)
      .get(trader.id) as { ts: number; status: string } | undefined;
    const preflight = app.db
      .prepare(`SELECT ts, target_mode, passed FROM preflight_runs ORDER BY id DESC LIMIT 1`)
      .get() as { ts: number; target_mode: string; passed: number } | undefined;

    return {
      adapterStatus,
      settlementBalance,
      ethGasBalance,
      baseAssetBalance,
      pendingTransactions: (app.db.prepare(
        `SELECT COUNT(*) n FROM execution_transactions WHERE state IN ('prepared','signed','broadcast','unknown')`,
      ).get() as { n: number }).n,
      lastReconciliation: recon
        ? { at: recon.ts, clean: recon.status === 'clean' }
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

  server.post('/api/live/window', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
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

  server.delete('/api/live/window', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    return closeNow(app.db, `user:${user.id}`);
  });

  // GLOBAL PROCESS: the funnel, every number measured
  server.get('/api/live/process', async () => {
    const cfg = getLiveConfig(app.db);
    const realMoney = cfg.mode === 'canary' || cfg.mode === 'live';
    const asOf = Date.now() - (realMoney ? 15 * 60_000 : 0);
    const dayStart = Math.floor(asOf / 86_400_000) * 86_400_000;
    const hourAgo = asOf - 3_600_000;

    const lastPass = app.db.prepare(`SELECT * FROM scan_passes WHERE ts <= ? ORDER BY id DESC LIMIT 1`).get(asOf) as any;
    const window = app.db
      .prepare(
        `SELECT COALESCE(SUM(markets_observed),0) obs, COALESCE(SUM(candidates),0) c,
                COALESCE(SUM(signals),0) s, COALESCE(SUM(high_confidence),0) h,
                COUNT(*) passes, COALESCE(AVG(duration_ms),0) avg_ms,
                COALESCE(MAX(markets_observed),0) universe
         FROM scan_passes WHERE ts BETWEEN ? AND ?`,
      )
      .get(hourAgo, asOf) as any;
    const rejected = app.db
      .prepare(`SELECT COUNT(*) n FROM opportunities WHERE state = 'rejected' AND ts BETWEEN ? AND ?`)
      .get(hourAgo, asOf) as { n: number };
    const orders = app.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state IN ('risk_approved','submitting','open','partial','filled') THEN 1 ELSE 0 END) approved,
           SUM(CASE WHEN state IN ('submitting','open','partial','filled') THEN 1 ELSE 0 END) routed,
           SUM(CASE WHEN state = 'filled' THEN 1 ELSE 0 END) executed
         FROM live_orders WHERE created_at BETWEEN ? AND ?`,
      )
      .get(dayStart, asOf) as any;

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
      delayedAsOf: realMoney ? asOf : null,
      note: 'scanner opportunities are advisory — only a machine committing capital reaches execution',
    };
  });

  // recent opportunities with their full edge math
  server.get('/api/live/opportunities', async (request) => {
    const q = z.object({
      limit: z.coerce.number().min(1).max(80).default(30),
      state: z.enum(['all', 'high_confidence', 'rejected']).default('all'),
    }).parse(request.query);
    const cfg = getLiveConfig(app.db);
    const realMoney = cfg.mode === 'canary' || cfg.mode === 'live';
    const asOf = Date.now() - (realMoney ? 15 * 60_000 : 0);
    const stateClause = q.state === 'all' ? '' : `AND state = '${q.state}'`;
    const rows = app.db
      .prepare(`SELECT * FROM opportunities WHERE ts <= ? ${stateClause} ORDER BY id DESC LIMIT ?`)
      .all(asOf, q.limit) as any[];
    return {
      delayedAsOf: realMoney ? asOf : null,
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

  server.get('/api/admin/live/orders', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
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
        txRef: o.tx_ref,
        confirmations: o.tx_ref ? ((app.db.prepare(
          `SELECT confirmations FROM execution_transactions WHERE order_id=? AND purpose='swap' ORDER BY id DESC LIMIT 1`,
        ).get(o.id) as { confirmations: number } | undefined)?.confirmations ?? 0) : 0,
        cleanFill: o.clean_fill === 1,
        forced: !!o.forced_by,
        operatorTest: o.operator_test === 1,
        experimentRunId: o.experiment_run_id,
        pair: o.sell_symbol && o.buy_symbol ? `${o.sell_symbol}/${o.buy_symbol}` : null,
        sellSymbol: o.sell_symbol,
        buySymbol: o.buy_symbol,
        sellContract: o.sell_contract,
        buyContract: o.buy_contract,
        sellDecimals: o.sell_decimals,
        buyDecimals: o.buy_decimals,
        sellAmountRaw: o.sell_amount_raw,
        minimumReceiveRaw: o.min_buy_amount_raw,
        quoteObservedAt: o.quote_observed_at,
        registrySnapshotHash: o.registry_snapshot_hash,
        councilRunId: o.council_run_id,
        reconciliationStatus: o.reconciliation_status,
        ts: o.created_at,
      }));
    return { orders };
  });

  // dry-run the gate for any mode without changing anything
  server.get('/api/admin/live/preflight', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    const q = z.object({
      mode: z.enum(['simulation', 'shadow', 'canary', 'live']).default('live'),
    }).parse(request.query);
    const result = await runPreflight(
      { db: app.db, signer: app.signer, adapters: app.adapters, feedStatus: app.feedStatus,
        ethUsd: app.executor.getMark('ETHUSDT') ?? null },
      q.mode,
      'dry-run',
      { persist: false },
    );
    return { ...result, lines: preflightLines(result), mappedSymbols: mappedSymbols() };
  });

  server.post('/api/admin/live/preflight', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({
      mode: z.enum(['shadow', 'canary', 'live']),
      stage: z.number().int().min(0).max(4).optional(),
    }).parse(request.body);
    const result = await runPreflight(
      { db: app.db, signer: app.signer, adapters: app.adapters, feedStatus: app.feedStatus,
        ethUsd: app.executor.getMark('ETHUSDT') ?? null },
      body.mode, `admin:${user.id}`, { targetStage: body.stage },
    );
    return { ...result, lines: preflightLines(result), mappedSymbols: mappedSymbols() };
  });

  server.post('/api/admin/live/funding/import', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(request.body);
    const account = accountForMode(app.db, 'canary', ROBINHOOD_VENUE);
    const wallet = await app.signer.getAddress();
    if (!wallet || !account.walletAddress || wallet.toLowerCase() !== account.walletAddress.toLowerCase()) {
      return reply.code(409).send({ error: 'signer and trader execution account are not bound to the same wallet' });
    }
    const adapter = app.adapters.get(ROBINHOOD_VENUE);
    if (!adapter?.getFundingTransfers) return reply.code(503).send({ error: 'Robinhood adapter cannot decode funding transfers' });
    try {
      const decoded = (await adapter.getFundingTransfers(body.txHash, wallet))
        .filter((e) => e.asset === 'USDG' || e.asset === 'ETH');
      if (decoded.length === 0) return reply.code(400).send({ error: 'transaction contains no USDG or ETH transfer into the trader wallet' });
      const inserted = recordFunding(app.db, account.id, decoded.map((e) => ({
        asset: e.asset, qty: e.qty, txRef: e.txRef, logIndex: e.logIndex,
        contractAddress: e.contractAddress, decimals: e.decimals, rawQty: e.rawQty,
        note: 'verified Robinhood Chain funding import',
      })), `admin:${user.id}`);
      return { ok: true, inserted, transfers: decoded.map((e) => ({ asset: e.asset, qty: e.qty, txRef: e.txRef })) };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.get('/api/admin/live/accounts', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    const cfg = getLiveConfig(app.db);
    const stageCap = stageCapUsd(cfg.capitalStage);
    return {
      accounts: listAccounts(app.db).map((a) => {
        const holdings = Object.fromEntries(custodyHoldings(app.db, a.id));
        const proof = app.db.prepare(
          `SELECT COUNT(*) total, SUM(CASE WHEN tx_ref IS NULL OR log_index IS NULL THEN 1 ELSE 0 END) unproven
           FROM execution_account_funding WHERE execution_account_id=?`,
        ).get(a.id) as { total: number; unproven: number | null };
        return {
          ...a,
          holdings,
          fundingProof: { total: proof.total, complete: proof.total > 0 && (proof.unproven ?? 0) === 0 },
          book: accountBook(app.db, a.id, a.mode === cfg.mode ? stageCap : a.fundedUsd),
        };
      }),
      promotion: promotionEvidence(app.db),
      allocations: app.db.prepare(
        `SELECT m.bot_id botId, b.name botName, m.allocated_usdg allocatedUsdg,
                m.active, m.actor, m.updated_at updatedAt
         FROM manager_capital_allocations m JOIN bots b ON b.id=m.bot_id
         WHERE m.execution_account_id=? ORDER BY b.name`,
      ).all(accountForMode(app.db, 'canary', ROBINHOOD_VENUE).id),
      bots: app.db.prepare(
        `SELECT id, name, status FROM bots WHERE status IN ('running','paused') ORDER BY name`,
      ).all(),
    };
  });

  server.get('/api/admin/live/discussions', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    const sessions = app.db.prepare(
      `SELECT s.*, o.intent_id, o.state order_state, o.instrument_id
       FROM research_sessions s LEFT JOIN live_orders o ON o.id=s.related_order_id
       WHERE s.advisory=1 ORDER BY s.id DESC LIMIT ?`,
    ).all(q.limit) as any[];
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        kind: session.kind,
        topic: session.topic,
        orderId: session.related_order_id,
        signalId: session.related_signal_id,
        orderState: session.order_state,
        instrumentId: session.instrument_id,
        advisory: true,
        measuredInputs: session.measured_inputs_json ? JSON.parse(session.measured_inputs_json) : null,
        transcript: session.transcript_json ? JSON.parse(session.transcript_json) : [],
        turns: session.turns,
        tokensIn: session.tokens_in,
        tokensOut: session.tokens_out,
        costUsd: fromMicro(session.cost_micro),
        outcome: session.outcome,
        startedAt: session.started_at,
        endedAt: session.ended_at,
      })),
    };
  });

  server.get('/api/admin/live/audit', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
    const q = z.object({ limit: z.coerce.number().min(1).max(200).default(100) }).parse(request.query);
    const rows = app.db.prepare(
      `SELECT id, ts, actor, action, payload_json, prev_hash, hash
       FROM audit_log
       WHERE action LIKE 'live_%' OR action LIKE 'capital_%' OR action LIKE 'manager_capital_%'
          OR action IN ('preflight','account_funding','order_approved','order_rejected','reconciliation_failure')
       ORDER BY id DESC LIMIT ?`,
    ).all(q.limit) as any[];
    return {
      events: rows.map((row) => ({
        id: row.id, ts: row.ts, actor: row.actor, action: row.action,
        details: row.payload_json ? JSON.parse(row.payload_json) : null,
        prevHash: row.prev_hash, hash: row.hash,
      })),
    };
  });

  server.post('/api/admin/live/allocations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({
      botId: z.number().int().positive(),
      allocatedUsdg: z.number().min(0).max(100),
    }).parse(request.body);
    const account = accountForMode(app.db, 'canary', ROBINHOOD_VENUE);
    const cfg = getLiveConfig(app.db);
    const reconciledUsdg = custodyHoldings(app.db, account.id).get('USDG') ?? 0;
    const authorized = Math.min(stageCapUsd(cfg.capitalStage), reconciledUsdg);
    try {
      setBotAllocation(app.db, account.id, body.botId, body.allocatedUsdg,
        `admin:${user.id}`, authorized);
      return { ok: true, botId: body.botId, allocatedUsdg: body.allocatedUsdg, authorizedCapitalUsd: authorized };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.post('/api/admin/live/reconcile', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    return { passes: await reconcileAll(app.db, app.hub, app.adapters) };
  });

  server.get('/api/admin/live/venues', async (request, reply) => {
    if (!requireAdmin(app, request, reply)) return;
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
  server.post('/api/admin/live/mode', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ mode: z.enum(['simulation', 'shadow']) }).parse(request.body);
    if (body.mode === 'shadow' && getLiveConfig(app.db).halted) {
      if (!app.supervisor) return reply.code(503).send({ error: 'autonomous supervisor not available' });
      try {
        const preflight = await app.supervisor.armShadow(`admin:${user.id}`);
        return { ok: true, mode: 'shadow', preflight };
      } catch (error) {
        return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
      }
    }
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

  server.post('/api/admin/live/halt', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ reason: z.string().max(200).default('operator halt') }).parse(request.body ?? {});
    haltNetwork(app.db, body.reason, `admin:${user.id}`);
    app.hub.publish('live', { event: 'halted', reason: body.reason });
    return { ok: true };
  });

  server.post('/api/admin/live/arm', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    if (!app.supervisor) return reply.code(503).send({ error: 'autonomous supervisor not available' });
    const body = z.object({
      mode: z.enum(['canary', 'live']),
      stage: z.number().int().min(1).max(4),
      confirmation: z.string(),
    }).parse(request.body);
    const expected = `ARM ROBINHOOD 4663 $${stageCapUsd(body.stage)}`;
    if (body.confirmation !== expected) return reply.code(400).send({ error: `confirmation must equal: ${expected}` });
    try {
      const preflight = await app.supervisor.arm(body.mode, body.stage, `admin:${user.id}`);
      return { ok: true, mode: body.mode, stage: body.stage, preflight };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.post('/api/admin/live/probe/roundtrip', { config: { rateLimit: { max: 1, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    if (!app.canaryExperiment) return reply.code(503).send({ error: 'canary experiment coordinator unavailable' });
    const body = z.object({
      sponsorBotId: z.number().int().positive(),
      idempotencyKey: z.string().min(12).max(100).regex(/^[a-zA-Z0-9:_-]+$/),
      confirmation: z.literal('RUN $0.50 ROUND TRIP'),
    }).parse(request.body);
    try {
      const experiment = await app.canaryExperiment.start(
        body.sponsorBotId, body.idempotencyKey, `admin:${user.id}`,
      );
      return { ok: true, experiment };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.post('/api/admin/live/canary/enable', { config: { rateLimit: { max: 1, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    if (!app.supervisor) return reply.code(503).send({ error: 'autonomous supervisor unavailable' });
    const body = z.object({
      confirmation: z.literal('ENABLE AUTONOMOUS CANARY $5'),
    }).parse(request.body);
    try {
      const preflight = await app.supervisor.enableCanaryAutonomy(`admin:${user.id}`);
      return { ok: true, phase: 'autonomous_canary', preflight };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  // OPERATOR FORCE — the one way to put a trade through without a strategy.
  //
  // It exists because an execution path that has never carried a real
  // transaction is not a tested path, and the strategies may stay quiet for
  // days. It overrides the two gates that ask "did we want this trade?"
  // (confidence, net edge) and NONE of the gates that protect funds. The
  // override is written into the order's risk_json and the audit log, so a
  // forced fill can never later be read as a strategy's success.
  server.post('/api/admin/live/force-trade', { config: { rateLimit: { max: 2, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    if (!app.liveNetwork) {
      reply.code(503);
      return { error: 'live pipeline not wired in this process' };
    }
    const cfg = getLiveConfig(app.db);
    if (cfg.mode === 'simulation' || cfg.mode === 'shadow') {
      reply.code(409);
      return { error: `mode is ${cfg.mode} — a forced trade would not reach a venue` };
    }
    const body = z
      .object({
        botId: z.number().int().positive(),
        symbol: z.string().min(3).max(20),
        side: z.enum(['buy', 'sell']),
        // The upper bound is the stage's own per-trade cap, applied again in
        // the risk engine. Stating it here too means an operator typo is
        // refused at the door rather than clamped silently.
        notionalUsd: z.number().min(0.5).max((stageCapUsd(cfg.capitalStage) * cfg.limits.maxPerTradePct) / 100),
        idempotencyKey: z.string().min(12).max(100).regex(/^[a-zA-Z0-9:_-]+$/),
      })
      .parse(request.body ?? {});

    const result = await app.liveNetwork.forceTrade({ ...body, actor: `operator:${user.id}` });
    return { ok: result.state === 'filled' || result.state === 'pending', ...result };
  });

  server.post('/api/admin/live/limits', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
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

  server.post('/api/admin/live/stage', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({
      stage: z.number().int().min(0).max(4),
    }).parse(request.body);
    try {
      const current = getLiveConfig(app.db);
      if (body.stage > current.capitalStage) {
        if (!app.supervisor) return reply.code(503).send({ error: 'autonomous supervisor not available' });
        const preflight = await app.supervisor.promoteStage(body.stage, `admin:${user.id}`);
        return { ok: true, stage: body.stage, preflight };
      }
      setCapitalStage(app.db, body.stage, `admin:${user.id}`);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    return { ok: true, stage: body.stage };
  });
}
