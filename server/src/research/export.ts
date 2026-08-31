import type { DB } from '../db/db.js';
import { trackRecord } from './scoring.js';
import { currentWindow } from './window.js';

// THE RESEARCH RECORD.
//
// What the network learned, in a form that survives the database and can live
// somewhere private. This is deliberately NOT written into the repo: it is
// trading history for one operator's wallet, and it belongs on their machine,
// not in a public git tree.
//
// The point of exporting rather than only querying is that the confidence
// weights are a summary — a handful of numbers — and a summary cannot be
// re-examined once you doubt it. The raw outcomes can.
//
// Everything here is MEASURED. There is no field for what a strategy was
// supposed to do, only for what happened: the approved size, the quote, the
// receipt, the realised move, and for rejected orders the named reason. The
// rejections matter as much as the fills; a network that only records its
// trades cannot learn why most ideas were refused.

export interface ResearchExport {
  generatedAt: string;
  window: {
    id: number | null;
    openedAt: string | null;
    closesAt: string | null;
    open: boolean;
    settings: unknown;
  };
  execution: {
    mode: string;
    capitalStage: number;
    limits: unknown;
  };
  orders: unknown[];
  fills: unknown[];
  rejections: { reason: string; count: number }[];
  predictions: {
    resolved: number;
    voided: number;
    byClaimKind: unknown[];
  };
  confidenceWeights: unknown[];
  trackRecord: unknown[];
  reconciliation: unknown[];
}

export function buildResearchExport(db: DB): ResearchExport {
  const cfg = db.prepare(`SELECT mode, capital_stage, limits_json FROM live_config WHERE id = 1`).get() as any;
  const win = currentWindow(db);

  const orders = db
    .prepare(
      `SELECT id, intent_id, bot_id, instrument_id, venue, side, mode, state,
              requested_notional_micro, approved_notional_micro, confidence,
              expected_price, executed_price, slippage_bps, fee_micro, filled_qty,
              reject_reason, risk_json, tx_ref, created_at, updated_at
       FROM live_orders WHERE mode IN ('canary','live') ORDER BY id DESC LIMIT 5000`,
    )
    .all();

  const fills = db
    .prepare(
      `SELECT l.id, l.order_id, l.instrument_id, l.venue, l.side, l.qty,
              l.expected_price, l.executed_price, l.fee_micro, l.gas_micro,
              l.slippage_bps, l.realized_pnl_micro, l.mode, l.tx_ref, l.ts
       FROM live_ledger l WHERE l.mode IN ('canary','live') ORDER BY l.id DESC LIMIT 5000`,
    )
    .all();

  // Why ideas died. The most valuable column in the whole export: it is the
  // record of what the network refused and on what grounds.
  const rejections = db
    .prepare(
      `SELECT reject_reason reason, COUNT(*) count FROM live_orders
       WHERE reject_reason IS NOT NULL GROUP BY reject_reason ORDER BY count DESC`,
    )
    .all() as { reason: string; count: number }[];

  const byClaimKind = db
    .prepare(
      `SELECT claim_kind, COUNT(*) n,
              SUM(CASE WHEN resolved_at IS NOT NULL AND void_reason IS NULL THEN 1 ELSE 0 END) resolved,
              SUM(CASE WHEN void_reason IS NOT NULL THEN 1 ELSE 0 END) voided,
              AVG(CASE WHEN brier IS NOT NULL THEN brier END) mean_brier
       FROM agent_predictions GROUP BY claim_kind`,
    )
    .all();
  const counts = db
    .prepare(
      `SELECT SUM(CASE WHEN resolved_at IS NOT NULL AND void_reason IS NULL THEN 1 ELSE 0 END) resolved,
              SUM(CASE WHEN void_reason IS NOT NULL THEN 1 ELSE 0 END) voided
       FROM agent_predictions`,
    )
    .get() as { resolved: number | null; voided: number | null };

  const version = db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as { v: number | null };
  const weights = version.v === null ? [] : db
    .prepare(`SELECT version, component, base_weight, weight, shrunk_skill, resolved_n, computed_at
              FROM confidence_weights WHERE version = ?`)
    .all(version.v);

  return {
    generatedAt: new Date().toISOString(),
    window: {
      id: win.id,
      openedAt: win.openedAt ? new Date(win.openedAt).toISOString() : null,
      closesAt: win.closesAt ? new Date(win.closesAt).toISOString() : null,
      open: win.open,
      settings: win.settings,
    },
    execution: {
      mode: cfg?.mode ?? 'unknown',
      capitalStage: cfg?.capital_stage ?? 0,
      limits: cfg?.limits_json ? JSON.parse(cfg.limits_json) : null,
    },
    orders,
    fills,
    rejections,
    predictions: {
      resolved: counts.resolved ?? 0,
      voided: counts.voided ?? 0,
      byClaimKind,
    },
    confidenceWeights: weights,
    trackRecord: trackRecord(db),
    reconciliation: db
      .prepare(`SELECT ts, asset, venue_qty, ledger_qty, drift, within_tolerance
                FROM balance_snapshots ORDER BY id DESC LIMIT 200`)
      .all(),
  };
}

/** A short human summary, so the folder is readable without a JSON viewer. */
export function summarise(x: ResearchExport): string {
  const lines: string[] = [];
  lines.push(`PUNKLABZ RESEARCH RECORD — ${x.generatedAt}`);
  lines.push('');
  lines.push(`execution      ${x.execution.mode}, capital stage ${x.execution.capitalStage}`);
  lines.push(`window         ${x.window.open ? `OPEN, closes ${x.window.closesAt}` : 'closed'}`);
  lines.push(`orders         ${x.orders.length}`);
  lines.push(`fills          ${x.fills.length}`);
  lines.push(`predictions    ${x.predictions.resolved} resolved, ${x.predictions.voided} voided`);
  lines.push('');
  lines.push('WHY IDEAS WERE REFUSED');
  if (x.rejections.length === 0) lines.push('  (nothing refused yet)');
  for (const r of x.rejections.slice(0, 15)) {
    lines.push(`  ${String(r.count).padStart(5)}  ${r.reason}`);
  }
  lines.push('');
  lines.push('CONFIDENCE WEIGHTS');
  if (x.confidenceWeights.length === 0) lines.push('  (cold start — no resolved predictions yet)');
  for (const w of x.confidenceWeights as any[]) {
    lines.push(`  ${w.component.padEnd(14)} ${w.weight.toFixed(4)}  (base ${w.base_weight}, n=${w.resolved_n})`);
  }
  lines.push('');
  lines.push('TRACK RECORD, against a coin flip at 0.25 Brier');
  if ((x.trackRecord as any[]).length === 0) lines.push('  (nothing resolved yet)');
  for (const t of x.trackRecord as any[]) {
    lines.push(`  ${t.agent} / ${t.claimKind}: n=${t.resolvedN} brier=${t.meanBrier.toFixed(3)} ${t.beatsBaseline ? 'better' : 'WORSE'}`);
  }
  return lines.join('\n');
}
