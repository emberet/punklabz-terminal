import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { ExecutionAdapter } from './adapters.js';
import { custodyHoldings, getAccount, listAccounts } from './accounts.js';
import { haltNetwork } from './riskEngine.js';
import { appendAudit } from '../audit/auditLog.js';
import { settleConfirmedOrder } from './settlement.js';

// RECONCILIATION.
//
// The database is what PunkLabz believes. The venue is what is true. When they
// disagree, PunkLabz is wrong — and it must stop trading rather than act on a
// belief the chain does not share.
//
// Tolerance is deliberately tight. A drift larger than dust means either an
// unrecorded fill, a double-spend, or an external transfer, and all three are
// reasons to halt and have a human look.

const DRIFT_TOLERANCE = 1e-6;

export interface ReconcilePass {
  runId: number | null;
  accountId: number;
  accountName: string;
  ok: boolean;
  detail: string;
  drifts: { asset: string; venueQty: number; ledgerQty: number; drift: number }[];
}

/** what the ledger says an account holds, by asset */
/**
 * What we believe this account holds: EXTERNAL FUNDING plus the net of every
 * trade.
 *
 * The funding term is not decoration. Without it this returned trades only, so
 * a freshly funded wallet showed the whole balance as unexplained drift and
 * halted the network — the reconciler working correctly against an incomplete
 * ledger. Money entering an account from outside is an event, and it has to be
 * recorded like any other.
 *
 * Funding is what an operator ATTESTED to, never what the chain happened to
 * say. If the attested figure is wrong, the drift survives and the halt stands,
 * which is the entire point.
 */
export async function reconcileAccount(
  db: DB,
  hub: WsHub | null,
  accountId: number,
  adapter: ExecutionAdapter,
): Promise<ReconcilePass> {
  const account = getAccount(db, accountId);
  if (!account) {
    return { runId: null, accountId, accountName: 'unknown', ok: false, detail: 'account not found', drifts: [] };
  }
  // shadow custodies nothing — its ledger is definitionally authoritative
  if (account.mode === 'shadow' || account.mode === 'simulation') {
    return { runId: null, accountId, accountName: account.name, ok: true, detail: 'no custody to reconcile', drifts: [] };
  }
  const startedAt = Date.now();
  const runInfo = db.prepare(
    `INSERT INTO reconciliation_runs (execution_account_id, started_at, status, actor)
     VALUES (?, ?, 'running', 'reconciler')`,
  ).run(accountId, startedAt);
  const runId = Number(runInfo.lastInsertRowid);
  if (typeof adapter.reconcile !== 'function') {
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(Date.now(), `${adapter.venue} cannot report venue state`, runId);
    return {
      runId, accountId, accountName: account.name, ok: false, drifts: [],
      detail: `${adapter.venue} cannot report venue state — cannot verify what we believe`,
    };
  }

  let truth;
  try {
    if (!account.walletAddress) throw new Error('custody account is not bound to a wallet');
    truth = await adapter.reconcile(account.walletAddress);
  } catch (error) {
    const detail = `venue state unreadable: ${String(error).slice(0, 160)}`;
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(Date.now(), detail, runId);
    haltNetwork(db, `reconciliation failure on ${account.name}: ${detail}`, 'reconciler');
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, detail });
    return { runId, accountId, accountName: account.name, ok: false, detail, drifts: [] };
  }
  if (!truth.ok) {
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(Date.now(), truth.detail, runId);
    haltNetwork(db, `reconciliation failure on ${account.name}: ${truth.detail}`, 'reconciler');
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, detail: truth.detail });
    return { runId, accountId, accountName: account.name, ok: false, detail: truth.detail, drifts: [] };
  }

  const believed = custodyHoldings(db, accountId);
  const drifts: ReconcilePass['drifts'] = [];
  const ts = Date.now();
  const assets = new Set([...believed.keys(), ...truth.balances.map((b) => b.asset)]);

  for (const asset of assets) {
    const ledgerQty = believed.get(asset) ?? 0;
    const venueQty = truth.balances.find((b) => b.asset === asset)?.qty ?? 0;
    const drift = venueQty - ledgerQty;
    const within = Math.abs(drift) <= DRIFT_TOLERANCE;
    if (!within) drifts.push({ asset, venueQty, ledgerQty, drift });
    db.prepare(
      `INSERT INTO balance_snapshots
        (execution_account_id, ts, asset, venue_qty, ledger_qty, drift, within_tolerance, reconciliation_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(accountId, ts, asset, venueQty, ledgerQty, drift, within ? 1 : 0, runId);
  }

  const ok = drifts.length === 0;
  if (!ok) {
    const summary = drifts.map((d) => `${d.asset} drift ${d.drift.toFixed(8)}`).join(', ');
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, drifts });
    haltNetwork(db, `reconciliation failure on ${account.name}: ${summary}`, 'reconciler');
    hub?.publish('live', { event: 'reconciliation_failure', accountId, drifts });
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(ts, summary, runId);
  } else {
    db.transaction(() => {
      db.prepare(`UPDATE reconciliation_runs SET status='clean', completed_at=?, detail=? WHERE id=?`)
        .run(ts, `${assets.size} asset(s) match venue`, runId);
      db.prepare(
        `UPDATE live_orders SET clean_fill=1, reconciliation_run_id=?
         WHERE execution_account_id=? AND state='filled' AND clean_fill=0
           AND forced_by IS NULL AND confirmed_at IS NOT NULL AND confirmed_at <= ?
           AND EXISTS (
             SELECT 1 FROM execution_transactions t
             WHERE t.order_id=live_orders.id AND t.purpose='swap' AND t.state='confirmed'
               AND t.confirmations >= 12
           )`,
      ).run(runId, accountId, ts);
    })();
  }
  return {
    runId,
    accountId,
    accountName: account.name,
    ok,
    detail: ok ? `${assets.size} asset(s) match venue` : `${drifts.length} asset(s) drifted`,
    drifts,
  };
}

/**
 * Resolve orders that were in flight when the process stopped. A crash between
 * submission and confirmation must never produce a second transaction — we ask
 * the venue what happened instead of assuming.
 */
export async function recoverPendingOrders(
  db: DB,
  hub: WsHub | null,
  adapters: Map<string, ExecutionAdapter>,
): Promise<{ recovered: number; unresolved: number }> {
  const pending = db
    .prepare(
      `SELECT id, venue, venue_order_id, intent_id, state, mode FROM live_orders
       WHERE state IN ('submitting','submitted','pending','open','partial','reconciling')`,
    )
    .all() as { id: number; venue: string; venue_order_id: string | null; intent_id: string; state: string; mode: string }[];

  let recovered = 0;
  let unresolved = 0;
  let specificHaltRecorded = false;

  for (const o of pending) {
    const adapter = adapters.get(o.venue);
    const canQuery = adapter && typeof adapter.getOrderStatus === 'function' && o.venue_order_id;

    if (!canQuery) {
      // we cannot establish what happened — park it and refuse to trade this venue
      db.prepare(`UPDATE live_orders SET state = 'reconciling', reject_reason = ?, updated_at = ? WHERE id = ?`)
        .run('unresolvable on boot: venue cannot be queried', Date.now(), o.id);
      unresolved++;
      appendAudit(db, 'boot-recovery', 'order_unresolved', { orderId: o.id, intentId: o.intent_id, venue: o.venue });
      continue;
    }

    try {
      const status = await adapter!.getOrderStatus!(o.venue_order_id!);
      const map: Record<string, string> = {
        pending: 'pending', open: 'open', partial: 'partial',
        filled: 'filled', cancelled: 'cancelled', failed: 'failed', unknown: 'reconciling',
      };
      const next = map[status.state] ?? 'reconciling';
      if (next === 'filled' && (o.mode === 'canary' || o.mode === 'live')) {
        settleConfirmedOrder(db, o.id, status);
      } else {
        db.prepare(
          `UPDATE live_orders SET state = ?, filled_qty = ?, executed_price = COALESCE(?, executed_price),
           last_checked_at = ?, updated_at = ? WHERE id = ?`,
        ).run(next, status.filledQty, status.executedPrice ?? null, Date.now(), Date.now(), o.id);
      }
      const unsafeTerminal = (o.mode === 'canary' || o.mode === 'live')
        && (next === 'failed' || next === 'cancelled');
      if (next === 'reconciling' || unsafeTerminal) {
        unresolved++;
        if (unsafeTerminal) {
          haltNetwork(db, `order ${o.id} transaction ended ${next}: ${status.detail}`, 'boot-recovery');
          specificHaltRecorded = true;
        }
      } else recovered++;
      appendAudit(db, 'boot-recovery', 'order_recovered', { orderId: o.id, state: next, detail: status.detail });
    } catch (e) {
      unresolved++;
      appendAudit(db, 'boot-recovery', 'order_query_failed', { orderId: o.id, error: String(e).slice(0, 120) });
    }
  }

  if (unresolved > 0) {
    if (!specificHaltRecorded) {
      haltNetwork(db, `${unresolved} order(s) unresolved after restart — manual review required`, 'boot-recovery');
    }
    hub?.publish('live', { event: 'orders_unresolved', count: unresolved });
  }
  return { recovered, unresolved };
}

/** run reconciliation across every active non-shadow account */
export async function reconcileAll(
  db: DB,
  hub: WsHub | null,
  adapters: Map<string, ExecutionAdapter>,
  options: { includeCustody?: boolean } = {},
): Promise<ReconcilePass[]> {
  const out: ReconcilePass[] = [];
  for (const account of listAccounts(db)) {
    if (!account.active) continue;
    if (options.includeCustody === false && (account.mode === 'canary' || account.mode === 'live')) continue;
    const adapter = adapters.get(account.venue);
    if (!adapter) {
      const now = Date.now();
      const pass = {
        runId: null,
        accountId: account.id, accountName: account.name, ok: false,
        detail: `missing adapter for active account venue ${account.venue}`, drifts: [],
      };
      out.push(pass);
      if (account.mode === 'canary' || account.mode === 'live') {
        db.prepare(
          `INSERT INTO reconciliation_runs
            (execution_account_id, started_at, completed_at, status, detail, actor)
           VALUES (?, ?, ?, 'failed', ?, 'reconciler')`,
        ).run(account.id, now, now, pass.detail);
        haltNetwork(db, pass.detail, 'reconciler');
        appendAudit(db, 'reconciler', 'adapter_missing', { accountId: account.id, venue: account.venue });
      }
      continue;
    }
    out.push(await reconcileAccount(db, hub, account.id, adapter));
  }
  return out;
}
