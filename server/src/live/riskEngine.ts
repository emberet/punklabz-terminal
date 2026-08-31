import {
  CAPITAL_STAGES, DEFAULT_LIMITS,
  type ExecutionMode, type OrderIntent, type RiskCheck, type RiskDecision, type RiskLimits,
} from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { fromMicro, toMicro } from '../money.js';
import { appendAudit } from '../audit/auditLog.js';

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

export function setLiveMode(db: DB, mode: ExecutionMode, actor: string): void {
  getLiveConfig(db); // ensure the config row exists
  // structural gate: canary/live need a signer, and none exists in this build.
  if (mode === 'canary' || mode === 'live') {
    throw new Error(
      'REFUSED: canary/live execution requires a configured signing service and funded venue credentials. ' +
      'This build has none — top mode is SHADOW.',
    );
  }
  db.prepare(`UPDATE live_config SET mode = ?, updated_at = ? WHERE id = 1`).run(mode, Date.now());
  appendAudit(db, actor, 'live_mode_change', { mode });
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

function snapshotPortfolio(db: DB, limits: RiskLimits, stageCap: number): PortfolioSnapshot {
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const open = db
    .prepare(
      `SELECT bot_id, approved_notional_micro FROM live_orders WHERE state IN ('risk_approved','submitting','open','partial','filled')
       AND created_at >= ?`,
    )
    .all(Date.now() - 7 * 86_400_000) as { bot_id: number | null; approved_notional_micro: number | null }[];
  // deployed = filled-side exposure still on book: this build closes shadow
  // round-trips immediately, so open exposure comes from unclosed states only
  const openStates = db
    .prepare(`SELECT bot_id, approved_notional_micro FROM live_orders WHERE state IN ('risk_approved','submitting','open','partial')`)
    .all() as { bot_id: number | null; approved_notional_micro: number | null }[];
  const perBot = new Map<number, number>();
  let deployed = 0;
  for (const o of openStates) {
    const usd = fromMicro(o.approved_notional_micro ?? 0);
    deployed += usd;
    if (o.bot_id !== null) perBot.set(o.bot_id, (perBot.get(o.bot_id) ?? 0) + usd);
  }
  const today = db
    .prepare(`SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s FROM live_ledger WHERE ts >= ?`)
    .get(dayStart) as { s: number };
  const allTime = db
    .prepare(`SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s FROM live_ledger`)
    .get() as { s: number };
  const navUsd = stageCap + fromMicro(allTime.s);
  // peak NAV from running ledger cumulative
  const rows = db.prepare(`SELECT realized_pnl_micro - fee_micro - gas_micro AS d FROM live_ledger ORDER BY ts ASC`).all() as { d: number }[];
  let cum = stageCap;
  let peak = stageCap;
  for (const r of rows) {
    cum += fromMicro(r.d);
    peak = Math.max(peak, cum);
  }
  void open;
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
export function evaluateIntent(db: DB, intent: OrderIntent, edge?: EdgeInput): RiskDecision {
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

  const snap = snapshotPortfolio(db, cfg.limits, stageCap);
  const maxPerTrade = (stageCap * cfg.limits.maxPerTradePct) / 100;
  const size = Math.min(intent.notionalUsd, maxPerTrade);

  if (stageCap <= 0) fail('capital_stage', 'stage 0: $0 deployable — shadow accounting only');
  else pass('capital_stage', `stage ${cfg.capitalStage}: cap $${stageCap}`);

  if (size < 0.5) fail('min_size', 'approved size below $0.50 — not worth fees');
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

export function setCapitalStage(db: DB, stage: number, actor: string): void {
  getLiveConfig(db); // ensure the config row exists
  const clamped = Math.max(0, Math.min(CAPITAL_STAGES.length - 1, Math.floor(stage)));
  // structural gate: stages >0 meaningless without a signer, but allow staging
  // config for shadow-accounting realism up to stage 1 only.
  if (clamped > 1) {
    throw new Error('REFUSED: stages above 1 ($5) require a configured signer and validated canary evidence.');
  }
  db.prepare(`UPDATE live_config SET capital_stage = ?, updated_at = ? WHERE id = 1`).run(clamped, Date.now());
  appendAudit(db, actor, 'capital_stage_change', { stage: clamped });
}
