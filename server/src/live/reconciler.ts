import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { ExecutionAdapter } from './adapters.js';
import { getAccount, listAccounts } from './accounts.js';
import { haltNetwork } from './riskEngine.js';
import { appendAudit } from '../audit/auditLog.js';

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
  accountId: number;
  accountName: string;
  ok: boolean;
  detail: string;
  drifts: { asset: string; venueQty: number; ledgerQty: number; drift: number }[];
}

/** what the ledger says an account holds, by asset */
function ledgerHoldings(db: DB, accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT instrument_id, side, SUM(qty) q FROM live_ledger
       WHERE execution_account_id = ? GROUP BY instrument_id, side`,
    )
    .all(accountId) as { instrument_id: string; side: string; q: number }[];
  const held = new Map<string, number>();
  for (const r of rows) {
    const asset = r.instrument_id.split('/').pop()?.replace('USDT', '') ?? r.instrument_id;
    held.set(asset, (held.get(asset) ?? 0) + (r.side === 'buy' ? r.q : -r.q));
  }
  return held;
}

export async function reconcileAccount(
  db: DB,
  hub: WsHub | null,
  accountId: number,
  adapter: ExecutionAdapter,
): Promise<ReconcilePass> {
  const account = getAccount(db, accountId);
  if (!account) {
    return { accountId, accountName: 'unknown', ok: false, detail: 'account not found', drifts: [] };
  }
  // shadow custodies nothing — its ledger is definitionally authoritative
  if (account.mode === 'shadow' || account.mode === 'simulation') {
    return { accountId, accountName: account.name, ok: true, detail: 'no custody to reconcile', drifts: [] };
  }
  if (typeof adapter.reconcile !== 'function') {
    return {
      accountId, accountName: account.name, ok: false, drifts: [],
      detail: `${adapter.venue} cannot report venue state — cannot verify what we believe`,
    };
  }

  const truth = await adapter.reconcile();
  if (!truth.ok) {
    return { accountId, accountName: account.name, ok: false, detail: truth.detail, drifts: [] };
  }

  const believed = ledgerHoldings(db, accountId);
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
      `INSERT INTO balance_snapshots (execution_account_id, ts, asset, venue_qty, ledger_qty, drift, within_tolerance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(accountId, ts, asset, venueQty, ledgerQty, drift, within ? 1 : 0);
  }

  const ok = drifts.length === 0;
  if (!ok) {
    const summary = drifts.map((d) => `${d.asset} drift ${d.drift.toFixed(8)}`).join(', ');
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, drifts });
    haltNetwork(db, `reconciliation failure on ${account.name}: ${summary}`, 'reconciler');
    hub?.publish('live', { event: 'reconciliation_failure', accountId, drifts });
  }
  return {
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
      `SELECT id, venue, venue_order_id, intent_id, state FROM live_orders
       WHERE state IN ('submitting','submitted','pending','open','partial','reconciling')`,
    )
    .all() as { id: number; venue: string; venue_order_id: string | null; intent_id: string; state: string }[];

  let recovered = 0;
  let unresolved = 0;

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
      db.prepare(
        `UPDATE live_orders SET state = ?, filled_qty = ?, executed_price = COALESCE(?, executed_price),
         last_checked_at = ?, updated_at = ? WHERE id = ?`,
      ).run(next, status.filledQty, status.executedPrice ?? null, Date.now(), Date.now(), o.id);
      if (next === 'reconciling') unresolved++;
      else recovered++;
      appendAudit(db, 'boot-recovery', 'order_recovered', { orderId: o.id, state: next, detail: status.detail });
    } catch (e) {
      unresolved++;
      appendAudit(db, 'boot-recovery', 'order_query_failed', { orderId: o.id, error: String(e).slice(0, 120) });
    }
  }

  if (unresolved > 0) {
    haltNetwork(db, `${unresolved} order(s) unresolved after restart — manual review required`, 'boot-recovery');
    hub?.publish('live', { event: 'orders_unresolved', count: unresolved });
  }
  return { recovered, unresolved };
}

/** run reconciliation across every active non-shadow account */
export async function reconcileAll(
  db: DB,
  hub: WsHub | null,
  adapters: Map<string, ExecutionAdapter>,
): Promise<ReconcilePass[]> {
  const out: ReconcilePass[] = [];
  for (const account of listAccounts(db)) {
    if (!account.active) continue;
    const adapter = adapters.get(account.venue);
    if (!adapter) continue;
    out.push(await reconcileAccount(db, hub, account.id, adapter));
  }
  return out;
}
