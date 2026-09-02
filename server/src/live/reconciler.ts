import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { ExecutionAdapter } from './adapters.js';
import { custodyHoldings, getAccount, listAccounts } from './accounts.js';
import { haltNetwork } from './riskEngine.js';
import { appendAudit } from '../audit/auditLog.js';
import { settleConfirmedOrder } from './settlement.js';
import { rawHoldings } from './rawAssetLedger.js';
import { activeUniverse, universeAssets } from '../robinhood/universe.js';
import { revocationCache } from './delegation/revocationCache.js';

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

function containFailure(db: DB, account: ReturnType<typeof getAccount>, detail: string): 'bot' | 'house' {
  if (account?.delegationGrantId) {
    const grantId = account.delegationGrantId;
    db.transaction(() => {
      db.prepare(
        `UPDATE delegation_grants
         SET status=CASE WHEN status='active' THEN 'paused' ELSE status END,updated_at=?
         WHERE id=? AND status IN ('pending','active','paused')`,
      ).run(Date.now(), grantId);
      db.prepare(
        `UPDATE bot_live_wallets SET state='blocked',updated_at=?
         WHERE execution_account_id=?`,
      ).run(Date.now(), account.id);
      db.prepare(`UPDATE execution_accounts SET active=0 WHERE id=?`).run(account.id);
      appendAudit(db, 'reconciler', 'delegated_account_blocked', {
        accountId: account.id, grantId, detail,
      });
    })();
    revocationCache.revoke(grantId);
    return 'bot';
  }
  haltNetwork(db, detail, 'reconciler');
  return 'house';
}

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
    const detail = `${adapter.venue} cannot report venue state — cannot verify what we believe`;
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(Date.now(), detail, runId);
    containFailure(db, account, `reconciliation failure on ${account.name}: ${detail}`);
    return {
      runId, accountId, accountName: account.name, ok: false, drifts: [],
      detail,
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
    containFailure(db, account, `reconciliation failure on ${account.name}: ${detail}`);
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, detail });
    return { runId, accountId, accountName: account.name, ok: false, detail, drifts: [] };
  }
  if (!truth.ok) {
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(Date.now(), truth.detail, runId);
    containFailure(db, account, `reconciliation failure on ${account.name}: ${truth.detail}`);
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, detail: truth.detail });
    return { runId, accountId, accountName: account.name, ok: false, detail: truth.detail, drifts: [] };
  }

  const believed = custodyHoldings(db, accountId);
  const drifts: ReconcilePass['drifts'] = [];
  const ts = Date.now();
  const snapshot = activeUniverse(db);
  const rawMode = !!snapshot && truth.balances.every((balance) => balance.rawQty !== undefined && balance.contractAddress);
  const rawBelieved = rawMode ? rawHoldings(db, accountId) : new Map<string, bigint>();
  const snapshotContracts = snapshot
    ? new Set(universeAssets(db, snapshot.id).map((asset) => asset.contractAddress).concat('0x0000000000000000000000000000000000000000'))
    : new Set<string>();
  const assets = new Set([...believed.keys(), ...truth.balances.map((b) => b.asset)]);

  for (const asset of assets) {
    const venue = truth.balances.find((b) => b.asset === asset);
    const ledgerQty = believed.get(asset) ?? 0;
    const venueQty = venue?.qty ?? 0;
    const drift = venueQty - ledgerQty;
    let within = Math.abs(drift) <= DRIFT_TOLERANCE;
    if (rawMode && venue?.contractAddress && venue.rawQty !== undefined) {
      const contract = venue.contractAddress.toLowerCase();
      if (!snapshotContracts.has(contract)) within = false;
      else within = (rawBelieved.get(contract) ?? 0n) === BigInt(venue.rawQty);
    }
    if (!within) drifts.push({ asset, venueQty, ledgerQty, drift });
    db.prepare(
      `INSERT INTO balance_snapshots
        (execution_account_id, ts, asset, venue_qty, ledger_qty, drift, within_tolerance, reconciliation_run_id,
         contract_address, decimals, venue_raw, ledger_raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(accountId, ts, asset, venueQty, ledgerQty, drift, within ? 1 : 0, runId,
      venue?.contractAddress?.toLowerCase() ?? null, venue?.decimals ?? null, venue?.rawQty ?? null,
      venue?.contractAddress ? String(rawBelieved.get(venue.contractAddress.toLowerCase()) ?? 0n) : null);
  }
  if (rawMode) {
    for (const [contract, raw] of rawBelieved) {
      if (raw !== 0n && !snapshotContracts.has(contract)) {
        drifts.push({ asset: `UNKNOWN:${contract}`, venueQty: 0, ledgerQty: Number(raw), drift: -Number(raw) });
      }
    }
  }

  const ok = drifts.length === 0;
  if (!ok) {
    const summary = drifts.map((d) => `${d.asset} drift ${d.drift.toFixed(8)}`).join(', ');
    appendAudit(db, 'reconciler', 'reconciliation_failure', { accountId, drifts });
    const scope = containFailure(db, account, `reconciliation failure on ${account.name}: ${summary}`);
    hub?.publish('live', { event: 'reconciliation_failure', accountId, drifts, scope });
    db.prepare(`UPDATE reconciliation_runs SET status='failed', completed_at=?, detail=? WHERE id=?`)
      .run(ts, summary, runId);
  } else {
    db.transaction(() => {
      db.prepare(`UPDATE reconciliation_runs SET status='clean', completed_at=?, detail=? WHERE id=?`)
        .run(ts, `${assets.size} asset(s) match venue`, runId);
      db.prepare(
        `UPDATE live_orders SET clean_fill=1, reconciliation_run_id=?
         , reconciliation_status='clean'
         WHERE execution_account_id=? AND state='filled' AND clean_fill=0
           AND forced_by IS NULL AND operator_test=0
           AND confirmed_at IS NOT NULL AND confirmed_at <= ?
           AND ABS(COALESCE(slippage_bps, 0)) <= 35
           AND (registry_snapshot_hash IS NULL OR EXISTS (
             SELECT 1 FROM trading_council_runs c
             WHERE c.id=live_orders.council_run_id AND c.state='approved'
               AND c.approvals>=3 AND c.risk_approved=1 AND c.manager_approved=1
               AND c.model_score>=90
           ))
           AND EXISTS (
             SELECT 1 FROM execution_transactions t
             WHERE t.order_id=live_orders.id AND t.purpose='swap' AND t.state='confirmed'
               AND t.confirmations >= 12
           )`,
      ).run(runId, accountId, ts);
      if (account.delegationGrantId) {
        db.prepare(
          `UPDATE bot_live_wallets
           SET state=CASE
             WHEN (SELECT status FROM delegation_grants WHERE id=?)='pending' THEN 'ready'
             WHEN (SELECT status FROM delegation_grants WHERE id=?)='paused' THEN 'paused'
             ELSE state END,
             updated_at=?
           WHERE execution_account_id=?`,
        ).run(account.delegationGrantId, account.delegationGrantId, ts, accountId);
      }
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
        containFailure(db, account, pass.detail);
        appendAudit(db, 'reconciler', 'adapter_missing', { accountId: account.id, venue: account.venue });
      }
      continue;
    }
    out.push(await reconcileAccount(db, hub, account.id, adapter));
  }
  return out;
}
