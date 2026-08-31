import {
  CAPITAL_STAGES, DEFAULT_LIMITS, MIN_TRADE_USD,
  type ExecutionMode, type OrderIntent, type RiskCheck, type RiskDecision, type RiskLimits,
} from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { fromMicro, toMicro } from '../money.js';
import { appendAudit } from '../audit/auditLog.js';
// Circular by design: delegationPolicy needs getLiveConfig/promotionEvidence
// from here, and the gate needs the delegation checks. Safe only because both
// sides are hoisted `function` declarations used inside call bodies, never at
// module-evaluation time. Do not convert either to a `const` arrow.
import { evaluateDelegation, grantHeadroomUsd } from './delegation/delegationPolicy.js';

// The independent gate. Every proposed order — from any agent, any strategy,
// any mode above simulation — passes through here. It can always say no, and
// nothing downstream can widen what it approved. Agents cannot modify limits;
// only the operator route can, and that is audited.

export function getLiveConfig(db: DB): {
  mode: ExecutionMode;
  halted: boolean;
  haltReason: string | null;
  capitalStage: number;
  limits: RiskLimits;
} {
  let row = db.prepare(`SELECT * FROM live_config WHERE id = 1`).get() as any;
  if (!row) {
    db.prepare(
      `INSERT INTO live_config (id, mode, halted, capital_stage, limits_json, updated_at) VALUES (1, 'simulation', 0, 0, ?, ?)`,
    ).run(JSON.stringify(DEFAULT_LIMITS), Date.now());
    row = db.prepare(`SELECT * FROM live_config WHERE id = 1`).get();
  }
  return {
    mode: row.mode,
    halted: row.halted === 1,
    haltReason: row.halt_reason,
    capitalStage: row.capital_stage,
    limits: { ...DEFAULT_LIMITS, ...JSON.parse(row.limits_json) },
  };
}

/**
 * Change execution mode. Modes that can move real funds must pass a full
 * preflight first — the caller supplies the result. Nothing here asserts a
 * refusal: the gate is the evidence. Today the preflight fails (no signer, no
 * adapter, no instrument mapping), so canary and live remain closed for
 * reasons an operator can read and fix.
 */
export function setLiveMode(
  db: DB,
  mode: ExecutionMode,
  actor: string,
  preflight?: { passed: boolean; blockers: string[] },
): void {
  getLiveConfig(db); // ensure the config row exists
  if (mode === 'canary' || mode === 'live') {
    if (!preflight) {
      throw new Error('BLOCKED: a preflight result is required to enter canary or live mode');
    }
    if (!preflight.passed) {
      throw new Error(
        `BLOCKED: ${mode} preflight failed —\n  ${preflight.blockers.join('\n  ')}`,
      );
    }
  }
  db.prepare(`UPDATE live_config SET mode = ?, updated_at = ? WHERE id = 1`).run(mode, Date.now());
  appendAudit(db, actor, 'live_mode_change', { mode, preflightPassed: preflight?.passed ?? null });
}

export function haltNetwork(db: DB, reason: string, actor: string): void {
  getLiveConfig(db); // ensure the config row exists
  db.prepare(`UPDATE live_config SET halted = 1, halt_reason = ?, updated_at = ? WHERE id = 1`).run(reason, Date.now());
  appendAudit(db, actor, 'live_halt', { reason });
}

export function resumeNetwork(db: DB, actor: string): void {
  getLiveConfig(db); // ensure the config row exists
  db.prepare(`UPDATE live_config SET halted = 0, halt_reason = NULL, updated_at = ? WHERE id = 1`).run(Date.now());
  appendAudit(db, actor, 'live_resume', {});
}

export function stageCapUsd(stage: number): number {
  return CAPITAL_STAGES[Math.max(0, Math.min(CAPITAL_STAGES.length - 1, stage))];
}

interface PortfolioSnapshot {
  deployedUsd: number;
  perBotDeployedUsd: Map<number, number>;
  openPositions: number;
  todayPnlUsd: number;
  peakNavUsd: number;
  navUsd: number;
}

function snapshotPortfolio(
  db: DB,
  limits: RiskLimits,
  stageCap: number,
  accountId?: number,
): PortfolioSnapshot {
  // Scope every figure to ONE execution account. Shadow P&L must never appear
  // in a live account's NAV or drawdown.
  const acctFilter = accountId !== undefined ? ' AND execution_account_id = ?' : '';
  const acctArgs = accountId !== undefined ? [accountId] : [];
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const openStates = db
    .prepare(
      `SELECT bot_id, approved_notional_micro FROM live_orders
       WHERE state IN ('risk_approved','submitting','submitted','pending','open','partial')${acctFilter}`,
    )
    .all(...acctArgs) as { bot_id: number | null; approved_notional_micro: number | null }[];
  const perBot = new Map<number, number>();
  let deployed = 0;
  for (const o of openStates) {
    const usd = fromMicro(o.approved_notional_micro ?? 0);
    deployed += usd;
    if (o.bot_id !== null) perBot.set(o.bot_id, (perBot.get(o.bot_id) ?? 0) + usd);
  }
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s
       FROM live_ledger WHERE ts >= ?${acctFilter}`,
    )
    .get(dayStart, ...acctArgs) as { s: number };
  const allTime = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s
       FROM live_ledger WHERE 1=1${acctFilter}`,
    )
    .get(...acctArgs) as { s: number };
  const navUsd = stageCap + fromMicro(allTime.s);
  // peak NAV from running ledger cumulative
  const rows = db
    .prepare(
      `SELECT realized_pnl_micro - fee_micro - gas_micro AS d
       FROM live_ledger WHERE 1=1${acctFilter} ORDER BY ts ASC`,
    )
    .all(...acctArgs) as { d: number }[];
  let cum = stageCap;
  let peak = stageCap;
  for (const r of rows) {
    cum += fromMicro(r.d);
    peak = Math.max(peak, cum);
  }
  void limits;
  return {
    deployedUsd: deployed,
    perBotDeployedUsd: perBot,
    openPositions: openStates.length,
    todayPnlUsd: fromMicro(today.s),
    peakNavUsd: peak,
    navUsd,
  };
}

export interface EdgeInput {
  grossEdgeBps: number;
  feeBps: number;
  slippageBps: number;
  bufferBps: number;
  netEdgeBps: number;
  edgeModel: string;
}

/**
 * The gate. Pure decision + audit trail; caller persists the order row.
 * When an edge breakdown is supplied the net-edge rule applies:
 *   expected edge must survive fees + slippage + safety buffer.
 */
export interface DelegationContext {
  grantId: number;
  /**
   * Whether this order closes a position the machine already holds. The gate
   * cannot work this out — lots live in LiveNetwork's memory — so the caller
   * states it rather than the risk engine guessing.
   */
  hasOpenLot: boolean;
}

export function evaluateIntent(
  db: DB,
  intent: OrderIntent,
  edge?: EdgeInput,
  accountId?: number,
  delegation?: DelegationContext,
): RiskDecision {
  const cfg = getLiveConfig(db);
  const stageCap = stageCapUsd(cfg.capitalStage);
  const checks: RiskCheck[] = [];
  const fail = (name: string, detail: string) => checks.push({ name, pass: false, detail });
  const pass = (name: string, detail: string) => checks.push({ name, pass: true, detail });

  if (cfg.halted) fail('kill_switch', `network halted: ${cfg.haltReason ?? 'operator halt'}`);
  else pass('kill_switch', 'network active');

  if (cfg.mode === 'simulation') fail('mode', 'execution mode is SIMULATION — live pipeline disabled');
  else pass('mode', `mode ${cfg.mode.toUpperCase()}`);

  if (intent.confidence < cfg.limits.confidenceThreshold)
    fail('confidence', `composite ${intent.confidence} < threshold ${cfg.limits.confidenceThreshold}`);
  else pass('confidence', `composite ${intent.confidence} ≥ ${cfg.limits.confidenceThreshold}`);

  if (edge) {
    if (edge.netEdgeBps <= 0)
      fail('net_edge',
        `edge ${(edge.grossEdgeBps / 100).toFixed(2)}% − fees ${(edge.feeBps / 100).toFixed(2)}% − slippage ${(edge.slippageBps / 100).toFixed(2)}% − buffer ${(edge.bufferBps / 100).toFixed(2)}% = ${(edge.netEdgeBps / 100).toFixed(2)}%`);
    else
      pass('net_edge', `net ${(edge.netEdgeBps / 100).toFixed(2)}% after costs (${edge.edgeModel})`);
  }

  const snap = snapshotPortfolio(db, cfg.limits, stageCap, accountId);
  const maxPerTrade = (stageCap * cfg.limits.maxPerTradePct) / 100;

  // A delegated order can never exceed the wallet owner's own remaining
  // headroom, and the clamp lands HERE — before min_size, cash_reserve and
  // per_machine — so every one of those evaluates the size that would actually
  // be sent, not a larger one. An exit is not a spend, so it is not clamped:
  // clamping it to a spent-out cap would trap the owner in the position.
  // Without a grant this is Math.min(a, b, Infinity), which is exactly
  // Math.min(a, b) — the non-delegated path is unchanged, bit for bit.
  const isDelegatedExit = !!delegation && intent.side === 'sell' && delegation.hasOpenLot;
  const delegatedHeadroom =
    delegation && !isDelegatedExit ? grantHeadroomUsd(db, delegation.grantId) : Infinity;
  const size = Math.min(intent.notionalUsd, maxPerTrade, delegatedHeadroom);

  if (stageCap <= 0) fail('capital_stage', 'stage 0: $0 deployable — shadow accounting only');
  else pass('capital_stage', `stage ${cfg.capitalStage}: cap $${stageCap}`);

  if (size < MIN_TRADE_USD)
    fail('min_size', `size $${size.toFixed(2)} below the $${MIN_TRADE_USD.toFixed(2)} floor — not worth fees`);
  else pass('min_size', `size $${size.toFixed(2)}`);

  if (snap.openPositions >= cfg.limits.maxSimultaneousPositions)
    fail('max_positions', `${snap.openPositions} open ≥ limit ${cfg.limits.maxSimultaneousPositions}`);
  else pass('max_positions', `${snap.openPositions}/${cfg.limits.maxSimultaneousPositions} positions`);

  const reserve = (stageCap * cfg.limits.minCashReservePct) / 100;
  if (snap.deployedUsd + size > stageCap - reserve)
    fail('cash_reserve', `would breach ${cfg.limits.minCashReservePct}% reserve (deployed $${snap.deployedUsd.toFixed(2)} + $${size.toFixed(2)} > $${(stageCap - reserve).toFixed(2)})`);
  else pass('cash_reserve', 'reserve intact');

  if (intent.botId !== null) {
    const botDeployed = snap.perBotDeployedUsd.get(intent.botId) ?? 0;
    const maxPerBot = (stageCap * cfg.limits.maxPerMachinePct) / 100;
    if (botDeployed + size > maxPerBot)
      fail('per_machine', `machine exposure $${(botDeployed + size).toFixed(2)} > cap $${maxPerBot.toFixed(2)}`);
    else pass('per_machine', `machine exposure ok`);
  }

  const maxDailyLoss = (stageCap * cfg.limits.maxDailyLossPct) / 100;
  if (-snap.todayPnlUsd >= maxDailyLoss && maxDailyLoss > 0)
    fail('daily_loss', `today ${snap.todayPnlUsd.toFixed(2)} breaches max daily loss $${maxDailyLoss.toFixed(2)}`);
  else pass('daily_loss', `today ${snap.todayPnlUsd >= 0 ? '+' : ''}$${snap.todayPnlUsd.toFixed(2)}`);

  const ddPct = snap.peakNavUsd > 0 ? ((snap.peakNavUsd - snap.navUsd) / snap.peakNavUsd) * 100 : 0;
  if (ddPct >= cfg.limits.maxTotalDrawdownPct && stageCap > 0) {
    fail('drawdown', `drawdown ${ddPct.toFixed(1)}% ≥ kill threshold ${cfg.limits.maxTotalDrawdownPct}% — HALTING`);
    haltNetwork(db, `automatic circuit breaker: drawdown ${ddPct.toFixed(1)}%`, 'risk-engine');
  } else pass('drawdown', `drawdown ${ddPct.toFixed(1)}%`);

  // The wallet owner's own limits, applied ON TOP of every network limit above.
  // A delegated order must satisfy both; neither can widen the other.
  if (delegation) {
    for (const c of evaluateDelegation(db, delegation.grantId, intent, size, delegation.hasOpenLot)) {
      checks.push(c);
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const decision: RiskDecision = {
    approved: failed.length === 0,
    sizeUsd: failed.length === 0 ? size : 0,
    rejectionReason: failed.length ? failed.map((f) => f.name).join(', ') : null,
    checks,
  };
  appendAudit(db, 'risk-engine', decision.approved ? 'order_approved' : 'order_rejected', {
    intentId: intent.intentId,
    botId: intent.botId,
    instrument: intent.instrumentId,
    sizeUsd: decision.sizeUsd,
    rejectionReason: decision.rejectionReason,
    netEdgeBps: edge?.netEdgeBps ?? null,
  });
  return decision;
}

export function updateLimits(db: DB, patch: Partial<RiskLimits>, actor: string): RiskLimits {
  const cfg = getLiveConfig(db);
  // hard ceilings the operator route itself cannot exceed in this build
  const next: RiskLimits = { ...cfg.limits, ...patch };
  next.leverageMax = 1; // leverage stays disabled structurally
  next.totalCapitalUsd = Math.min(100, next.totalCapitalUsd);
  next.maxPerTradePct = Math.min(10, Math.max(0.5, next.maxPerTradePct));
  next.maxDailyLossPct = Math.min(10, Math.max(1, next.maxDailyLossPct));
  next.maxTotalDrawdownPct = Math.min(20, Math.max(2, next.maxTotalDrawdownPct));
  next.minCashReservePct = Math.max(10, next.minCashReservePct);
  db.prepare(`UPDATE live_config SET limits_json = ?, updated_at = ? WHERE id = 1`).run(JSON.stringify(next), Date.now());
  appendAudit(db, actor, 'risk_limits_change', { patch });
  return next;
}

export interface PromotionEvidence {
  cleanFills: number;
  drawdownPct: number;
  reconciliationClean: boolean;
  failedOrders: number;
}

/** what a stage must show before the next one unlocks */
export function promotionEvidence(db: DB): PromotionEvidence {
  const fills = db
    .prepare(`SELECT COUNT(*) n FROM live_orders WHERE state = 'filled' AND mode IN ('canary','live')`)
    .get() as { n: number };
  const failed = db
    .prepare(`SELECT COUNT(*) n FROM live_orders WHERE state IN ('failed','reconciling')`)
    .get() as { n: number };
  const lastRecon = db
    .prepare(`SELECT within_tolerance FROM balance_snapshots ORDER BY id DESC LIMIT 1`)
    .get() as { within_tolerance: number } | undefined;
  const cfg = getLiveConfig(db);
  const snap = snapshotPortfolio(db, cfg.limits, stageCapUsd(cfg.capitalStage));
  const dd = snap.peakNavUsd > 0 ? ((snap.peakNavUsd - snap.navUsd) / snap.peakNavUsd) * 100 : 0;
  return {
    cleanFills: fills.n,
    drawdownPct: dd,
    reconciliationClean: lastRecon ? lastRecon.within_tolerance === 1 : true,
    failedOrders: failed.n,
  };
}

/**
 * Promote or demote the capital stage. Demotion is always allowed. Promotion
 * requires evidence from the stage below: real clean fills, controlled
 * drawdown, clean reconciliation and no unresolved orders.
 */
export function setCapitalStage(db: DB, stage: number, actor: string, force = false): void {
  getLiveConfig(db); // ensure the config row exists
  const cfg = getLiveConfig(db);
  const clamped = Math.max(0, Math.min(CAPITAL_STAGES.length - 1, Math.floor(stage)));

  if (clamped > cfg.capitalStage && !force) {
    const ev = promotionEvidence(db);
    const blockers: string[] = [];
    // stage 1 is the first real-capital step; it needs infrastructure, not fills
    const requiredFills = clamped === 1 ? 0 : 10 * clamped;
    if (ev.cleanFills < requiredFills)
      blockers.push(`${ev.cleanFills} clean fill(s), ${requiredFills} required for stage ${clamped}`);
    if (ev.drawdownPct > cfg.limits.maxTotalDrawdownPct / 2)
      blockers.push(`drawdown ${ev.drawdownPct.toFixed(1)}% is more than half the kill threshold`);
    if (!ev.reconciliationClean) blockers.push('last reconciliation did not match the venue');
    if (ev.failedOrders > 0) blockers.push(`${ev.failedOrders} failed/unresolved order(s) outstanding`);
    if (blockers.length) {
      throw new Error(`BLOCKED: stage ${clamped} promotion needs —\n  ${blockers.join('\n  ')}`);
    }
  }

  db.prepare(`UPDATE live_config SET capital_stage = ?, updated_at = ? WHERE id = 1`).run(clamped, Date.now());
  appendAudit(db, actor, 'capital_stage_change', { stage: clamped, forced: force });
}
