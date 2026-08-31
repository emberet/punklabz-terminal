import Anthropic from '@anthropic-ai/sdk';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { toMicro, fromMicro } from '../money.js';
import { appendAudit } from '../audit/auditLog.js';
import {
  computeEpochProfitMicro,
  computePayouts,
  epochInputsHash,
  type HolderBalance,
} from './payoutMath.js';
import { saveSnapshot, type HolderSource } from './holderSource.js';
import type { PayoutQueue } from './payoutQueue.js';

const MODEL = 'claude-haiku-4-5-20251001';

// Deterministic anomaly rules — evaluated in code. Claude gets the results and
// may ADD flags (never remove) and writes the narrative. Claude cannot touch
// amounts: the approve path recomputes everything from stored inputs.
function detectAnomalies(
  db: DB,
  profitMicro: number,
  eligibleCount: number,
  perBotPnl: { botId: number; name: string; pnlMicro: number }[],
): string[] {
  const flags: string[] = [];
  const prior = db
    .prepare(
      `SELECT total_profit_micro FROM payout_epochs ORDER BY id DESC LIMIT 7`,
    )
    .all() as { total_profit_micro: number }[];
  if (prior.length >= 3) {
    const sorted = prior.map((p) => p.total_profit_micro).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0 && profitMicro > 3 * median)
      flags.push(`profit ${fromMicro(profitMicro).toFixed(2)} USD is >3x trailing median`);
  }
  const priorHolders = db
    .prepare(
      `SELECT e.id, COUNT(i.id) AS n FROM payout_epochs e
       LEFT JOIN payout_items i ON i.epoch_id = e.id
       GROUP BY e.id ORDER BY e.id DESC LIMIT 1`,
    )
    .get() as { n: number } | undefined;
  if (priorHolders && priorHolders.n > 0) {
    const delta = Math.abs(eligibleCount - priorHolders.n) / priorHolders.n;
    if (delta > 0.3) flags.push(`eligible holder count changed ${(delta * 100).toFixed(0)}% vs last epoch`);
  }
  const totalPositive = perBotPnl.filter((b) => b.pnlMicro > 0).reduce((s, b) => s + b.pnlMicro, 0);
  for (const b of perBotPnl) {
    if (totalPositive > 0 && b.pnlMicro > 0.8 * totalPositive && perBotPnl.length > 1)
      flags.push(`bot "${b.name}" contributed >80% of epoch profit`);
  }
  return flags;
}

export interface EpochRunResult {
  epochId: number;
  status: string;
  profitUsd: number;
  eligibleCount: number;
  anomalies: string[];
}

/**
 * Close an epoch: deterministic math -> persist -> Claude narration/anomaly pass
 * -> auto-approve (under cap, clean) or needs_review -> distribute if approved.
 */
export async function runEpoch(
  db: DB,
  holderSource: HolderSource,
  queue: PayoutQueue,
  opts: { periodStart?: number; periodEnd?: number } = {},
): Promise<EpochRunResult> {
  if (!config.payoutsEnabled) {
    throw new Error('real payouts are disabled; paper trades cannot fund treasury distributions');
  }
  const periodEnd = opts.periodEnd ?? Date.now();
  const lastEpoch = db
    .prepare('SELECT MAX(period_end) AS ts FROM payout_epochs')
    .get() as { ts: number | null };
  const periodStart = opts.periodStart ?? lastEpoch.ts ?? periodEnd - 86_400_000;

  // 1. deterministic inputs
  const pnlRows = db
    .prepare(
      `SELECT t.realized_pnl_micro AS pnl, t.bot_id AS botId, b.name
       FROM trades t JOIN bots b ON b.id = t.bot_id
       WHERE b.kind = 'house' AND t.ts > ? AND t.ts <= ?`,
    )
    .all(periodStart, periodEnd) as { pnl: number; botId: number; name: string }[];
  const holders: HolderBalance[] = await holderSource.getSnapshot();
  const profitMicro = computeEpochProfitMicro(pnlRows.map((r) => r.pnl));
  const payout = computePayouts(profitMicro, holders);
  const inputsHash = epochInputsHash({
    periodStart,
    periodEnd,
    realizedPnlMicros: pnlRows.map((r) => r.pnl),
    holders,
  });

  const perBot = new Map<number, { botId: number; name: string; pnlMicro: number }>();
  for (const r of pnlRows) {
    const e = perBot.get(r.botId) ?? { botId: r.botId, name: r.name, pnlMicro: 0 };
    e.pnlMicro += r.pnl;
    perBot.set(r.botId, e);
  }
  const anomalies = detectAnomalies(db, profitMicro, payout.eligible.length, [...perBot.values()]);

  // 2. persist epoch + items
  const snapshotId = saveSnapshot(db, holderSource.name, holders);
  const epochId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payout_epochs
           (period_start, period_end, total_profit_micro, eligible_supply, snapshot_id, status, inputs_hash, anomalies_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'computed', ?, ?, ?)`,
      )
      .run(periodStart, periodEnd, profitMicro, payout.eligibleSupply, snapshotId,
        inputsHash, JSON.stringify(anomalies), Date.now());
    const id = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      `INSERT INTO payout_items (epoch_id, address, balance, amount_micro, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of payout.eligible) stmt.run(id, e.address, e.balance, e.amountMicro, Date.now());
    return id;
  })();
  appendAudit(db, 'manager', 'epoch_computed', {
    epochId, periodStart, periodEnd, profitMicro,
    eligibleCount: payout.eligible.length, inputsHash, anomalies,
  });

  // 3. Claude pass: narrative + extra flags. Failure -> needs_review, canned summary.
  let summary: string;
  let claudeFlags: string[] = [];
  try {
    const res = await narrate(db, epochId, profitMicro, payout, [...perBot.values()], anomalies);
    summary = res.summary;
    claudeFlags = res.flags;
  } catch (e) {
    summary = `[agent offline] Epoch closed with ${fromMicro(profitMicro).toFixed(2)} USD profit across ${payout.eligible.length} eligible holders. Manual review required (narration failed: ${String(e).slice(0, 120)}).`;
    claudeFlags = ['claude narration failed'];
  }
  const allFlags = [...anomalies, ...claudeFlags];

  // 4. status: auto-approve small clean epochs, otherwise park for admin
  const autoOk = allFlags.length === 0 && profitMicro <= toMicro(config.autoApproveCapUsd);
  const status = autoOk ? 'approved' : 'needs_review';
  db.prepare(
    `UPDATE payout_epochs SET status = ?, claude_summary = ?, anomalies_json = ? WHERE id = ?`,
  ).run(status, summary, JSON.stringify(allFlags), epochId);
  appendAudit(db, 'manager', `epoch_${status}`, { epochId, flags: allFlags });

  // 5. distribute immediately when auto-approved
  if (status === 'approved') {
    await queue.distributeEpoch(epochId);
  }

  const finalRow = db.prepare('SELECT status FROM payout_epochs WHERE id = ?').get(epochId) as { status: string };
  return {
    epochId,
    status: finalRow.status,
    profitUsd: fromMicro(profitMicro),
    eligibleCount: payout.eligible.length,
    anomalies: allFlags,
  };
}

async function narrate(
  db: DB,
  epochId: number,
  profitMicro: number,
  payout: ReturnType<typeof computePayouts>,
  perBot: { name: string; pnlMicro: number }[],
  codeFlags: string[],
): Promise<{ summary: string; flags: string[] }> {
  if (!config.anthropicApiKey) throw new Error('no ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const facts = {
    epochId,
    profitUsd: fromMicro(profitMicro),
    eligibleHolders: payout.eligible.length,
    eligibleSupply: payout.eligibleSupply,
    dustUsd: fromMicro(payout.dustMicro),
    topPayouts: payout.eligible.slice(0, 3).map((e) => ({
      address: e.address.slice(0, 8) + '…',
      amountUsd: fromMicro(e.amountMicro),
    })),
    perBotPnlUsd: perBot.map((b) => ({ name: b.name, pnlUsd: fromMicro(b.pnlMicro) })),
    codeFlags,
  };
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      'You are the PunkLabz Terminal treasury manager agent. You receive FINISHED payout numbers computed by audited deterministic code. You cannot change any amount. ' +
      'Reply with strict JSON: {"summary": string, "flags": string[]}. ' +
      '"summary": 2-4 sentences in a terse crypto trading-desk voice describing the epoch (profit, holder count, notable bot contributions). No emojis. ' +
      '"flags": ONLY genuinely suspicious patterns in the data worth human review (empty array if clean). Do not repeat codeFlags.',
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  });
  const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text.replace(/^```(json)?\n?|```$/g, '').trim());
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.flags))
    throw new Error('bad narration shape');
  return { summary: parsed.summary, flags: parsed.flags.map(String).slice(0, 5) };
}

/**
 * Admin approval of a needs_review epoch. Re-derives payouts from the stored
 * snapshot and refuses to approve when stored items don't match — the
 * tamper-proof gate between narration and money.
 */
export async function approveEpoch(db: DB, epochId: number, adminUserId: number, queue: PayoutQueue): Promise<void> {
  if (!config.payoutsEnabled) throw new Error('payouts are disabled in this deployment');
  const epoch = db
    .prepare(`SELECT id, status, total_profit_micro, snapshot_id FROM payout_epochs WHERE id = ?`)
    .get(epochId) as { id: number; status: string; total_profit_micro: number; snapshot_id: number } | undefined;
  if (!epoch) throw new Error('epoch not found');
  if (epoch.status !== 'needs_review') throw new Error(`epoch is ${epoch.status}`);

  const holders = db
    .prepare('SELECT address, balance FROM holders WHERE snapshot_id = ?')
    .all(epoch.snapshot_id) as HolderBalance[];
  const recomputed = computePayouts(epoch.total_profit_micro, holders);
  const stored = db
    .prepare('SELECT address, amount_micro FROM payout_items WHERE epoch_id = ? ORDER BY address ASC')
    .all(epochId) as { address: string; amount_micro: number }[];

  if (stored.length !== recomputed.eligible.length)
    throw new Error('approve blocked: stored payout items do not match recomputation');
  for (let i = 0; i < stored.length; i++) {
    if (
      stored[i].address !== recomputed.eligible[i].address ||
      stored[i].amount_micro !== recomputed.eligible[i].amountMicro
    )
      throw new Error(`approve blocked: mismatch at ${stored[i].address}`);
  }

  db.prepare(`UPDATE payout_epochs SET status = 'approved' WHERE id = ?`).run(epochId);
  appendAudit(db, `admin:${adminUserId}`, 'epoch_approved_manual', { epochId });
  await queue.distributeEpoch(epochId);
}
