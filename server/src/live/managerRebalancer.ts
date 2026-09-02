import type { DB } from '../db/db.js';
import { appendAudit } from '../audit/auditLog.js';
import { accountForMode, setBotAllocation } from './accounts.js';
import { getLiveConfig, haltNetwork } from './riskEngine.js';

const MICRO = 1_000_000;

interface FillEvidence {
  netMicro: number;
  slippageBps: number;
  ts: number;
}

export interface ManagerBotScore {
  botId: number;
  name: string;
  fills: number;
  netReturn: number;
  drawdown: number;
  fillQuality: number;
  calibration: number;
  score: number;
  closeOnly: boolean;
  priorAllocationUsd: number;
  appliedAllocationUsd: number;
}

export interface ManagerRebalanceResult {
  runId: number;
  status: 'applied' | 'blocked';
  reason: string;
  authorizedCapitalUsd: number;
  reconciledNavUsd: number;
  reserveUsd: number;
  allocatableUsd: number;
  bots: ManagerBotScore[];
}

function fillsFor(db: DB, accountId: number, botId: number): FillEvidence[] {
  return (db.prepare(
    `SELECT (l.realized_pnl_micro-l.fee_micro-l.gas_micro) net_micro,
            ABS(l.slippage_bps) slippage_bps, l.ts
     FROM live_ledger l JOIN live_orders o ON o.id=l.order_id
     WHERE l.execution_account_id=? AND l.bot_id=? AND l.mode IN ('canary','live')
       AND o.clean_fill=1 AND o.forced_by IS NULL
     ORDER BY l.ts DESC LIMIT 30`,
  ).all(accountId, botId) as any[]).reverse().map((row) => ({
    netMicro: Number(row.net_micro), slippageBps: Number(row.slippage_bps), ts: Number(row.ts),
  }));
}

function maxDrawdown(fills: FillEvidence[], baseUsd: number): number {
  let equity = Math.max(baseUsd, 0.01);
  let peak = equity;
  let max = 0;
  for (const fill of fills) {
    equity += fill.netMicro / MICRO;
    peak = Math.max(peak, equity);
    if (peak > 0) max = Math.max(max, (peak - equity) / peak);
  }
  return max;
}

function calibrationFor(db: DB, botId: number): number {
  const row = db.prepare(
    `SELECT AVG(brier) mean_brier FROM (
       SELECT brier FROM agent_predictions
       WHERE bot_id=? AND resolved_at IS NOT NULL AND void_reason IS NULL
       ORDER BY resolved_at DESC LIMIT 30
     )`,
  ).get(botId) as { mean_brier: number | null } | undefined;
  return row?.mean_brier === null || row?.mean_brier === undefined
    ? 0.5
    : Math.max(0, Math.min(1, 1 - row.mean_brier));
}

/**
 * Deterministic Manager allocation. It changes limits, never wallet balances.
 * Onchain NAV is supplied by the reconciled adapter and is the hard ceiling.
 */
export function runManagerRebalance(
  db: DB,
  reconciledNavUsd: number,
  actor = 'manager:rebalance',
  navVerified = true,
): ManagerRebalanceResult {
  const account = accountForMode(db, 'canary', 'evm:robinhood');
  const cfg = getLiveConfig(db);
  const authorized = Number(cfg.authorizedCapitalUsdg);
  const capitalEvidenceValid = navVerified && Number.isFinite(authorized) && authorized > 0
    && Number.isFinite(reconciledNavUsd) && reconciledNavUsd >= 0;
  if (cfg.autonomyEnabled && !cfg.halted && !capitalEvidenceValid) {
    haltNetwork(db, 'Manager cannot verify authorized capital and reconciled Trader NAV', actor);
  }
  const capital = Number.isFinite(authorized) && Number.isFinite(reconciledNavUsd)
    ? Math.max(0, Math.min(authorized, reconciledNavUsd))
    : 0;
  const reserve = capital * 0.30;
  const allocatable = capital - reserve;
  const now = Date.now();
  const latestRecon = db.prepare(
    `SELECT status, completed_at FROM reconciliation_runs
     WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`,
  ).get(account.id) as { status: string; completed_at: number | null } | undefined;
  const blocked = cfg.halted || !cfg.autonomyEnabled
    || !capitalEvidenceValid
    || latestRecon?.status !== 'clean' || !latestRecon.completed_at
    || now - latestRecon.completed_at > 10 * 60_000;

  const bots = db.prepare(
    `SELECT b.id, b.name, COALESCE(a.allocated_usdg,0) allocated
     FROM bots b LEFT JOIN manager_capital_allocations a
       ON a.bot_id=b.id AND a.execution_account_id=?
     WHERE b.kind='house' AND b.status='running'
       AND b.name IN ('MOMENTUM RUNNER','MEAN REVERSION','GRID TRADER')
     ORDER BY b.id`,
  ).all(account.id) as { id: number; name: string; allocated: number }[];

  const measured = bots.map((bot) => {
    const fills = fillsFor(db, account.id, bot.id);
    const netUsd = fills.reduce((sum, fill) => sum + fill.netMicro / MICRO, 0);
    const netReturn = netUsd / Math.max(bot.allocated, 0.50);
    const drawdown = maxDrawdown(fills, Math.max(bot.allocated, 0.50));
    const fillQuality = fills.length
      ? 1 - Math.min(1, fills.reduce((sum, fill) => sum + fill.slippageBps, 0) / fills.length / 35)
      : 0.5;
    const calibration = calibrationFor(db, bot.id);
    const dayNet = fills.filter((fill) => fill.ts >= now - 86_400_000)
      .reduce((sum, fill) => sum + fill.netMicro / MICRO, 0);
    return {
      bot, fills, netReturn, drawdown, fillQuality, calibration,
      closeOnly: dayNet <= -Math.max(bot.allocated, 0.50) * 0.05,
    };
  });
  const returns = measured.map((row) => row.netReturn);
  const lo = Math.min(...returns, 0);
  const hi = Math.max(...returns, 0);

  const scored = measured.map((row) => {
    const normalizedReturn = hi === lo ? 0.5 : (row.netReturn - lo) / (hi - lo);
    const inverseDrawdown = 1 - Math.min(1, row.drawdown / 0.10);
    const raw = 0.40 * normalizedReturn + 0.25 * inverseDrawdown
      + 0.20 * row.fillQuality + 0.15 * row.calibration;
    const evidenceWeight = Math.min(1, row.fills.length / 10);
    const score = 0.5 + (raw - 0.5) * evidenceWeight;
    return { ...row, score: row.closeOnly ? 0 : Math.max(0, score) };
  });
  const scoreTotal = scored.reduce((sum, row) => sum + row.score, 0);
  const maxIncrease = capital * 0.10;
  const maxDecrease = capital * 0.20;
  const proposals = scored.map((row) => {
    const desired = row.closeOnly || scoreTotal === 0 ? 0 : allocatable * row.score / scoreTotal;
    const cappedUp = Math.min(desired, row.bot.allocated + maxIncrease);
    const cappedDown = Math.max(cappedUp, row.bot.allocated - maxDecrease);
    const target = row.closeOnly ? 0 : Math.max(0, cappedDown);
    return { row, target };
  });
  const proposedTotal = proposals.reduce((sum, item) => sum + item.target, 0);
  const scale = proposedTotal > allocatable && proposedTotal > 0 ? allocatable / proposedTotal : 1;
  const reason = blocked
    ? 'rebalance blocked: autonomy, capital, NAV, or fresh reconciliation is unavailable'
    : `${bots.length} house bot allocation(s) derived from reconciled NAV`;
  const runId = db.transaction(() => {
    const run = db.prepare(
      `INSERT INTO manager_rebalance_runs
       (execution_account_id, authorized_capital_micro, reconciled_nav_micro, reserve_micro,
        allocatable_micro, status, inputs_json, reason, actor, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      account.id, Math.round(authorized * MICRO), Math.round(reconciledNavUsd * MICRO),
      Math.round(reserve * MICRO), Math.round(allocatable * MICRO), blocked ? 'blocked' : 'applied',
      JSON.stringify({ formula: '40_return_25_inverse_drawdown_20_fill_15_calibration', lookback: 30 }),
      reason, actor, now, now,
    );
    const id = Number(run.lastInsertRowid);
    for (const proposal of proposals) {
      const applied = blocked ? proposal.row.bot.allocated : proposal.target * scale;
      if (!blocked) setBotAllocation(db, account.id, proposal.row.bot.id, applied, actor, capital);
      db.prepare(
        `INSERT INTO manager_rebalance_items
         (run_id, bot_id, prior_allocation_micro, target_allocation_micro,
          applied_allocation_micro, score_ppm, close_only, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, proposal.row.bot.id, Math.round(proposal.row.bot.allocated * MICRO),
        Math.round(proposal.target * MICRO), Math.round(applied * MICRO),
        Math.round(proposal.row.score * MICRO), proposal.row.closeOnly ? 1 : 0,
        JSON.stringify({ fills: proposal.row.fills.length, netReturn: proposal.row.netReturn,
          drawdown: proposal.row.drawdown, fillQuality: proposal.row.fillQuality,
          calibration: proposal.row.calibration }),
      );
    }
    appendAudit(db, actor, 'manager_rebalance', { runId: id, blocked, capital, reserve, allocatable });
    return id;
  })();

  return {
    runId, status: blocked ? 'blocked' : 'applied', reason,
    authorizedCapitalUsd: authorized, reconciledNavUsd, reserveUsd: reserve,
    allocatableUsd: allocatable,
    bots: proposals.map((proposal) => ({
      botId: proposal.row.bot.id, name: proposal.row.bot.name, fills: proposal.row.fills.length,
      netReturn: proposal.row.netReturn, drawdown: proposal.row.drawdown,
      fillQuality: proposal.row.fillQuality, calibration: proposal.row.calibration,
      score: proposal.row.score, closeOnly: proposal.row.closeOnly,
      priorAllocationUsd: proposal.row.bot.allocated,
      appliedAllocationUsd: blocked ? proposal.row.bot.allocated : proposal.target * scale,
    })),
  };
}
