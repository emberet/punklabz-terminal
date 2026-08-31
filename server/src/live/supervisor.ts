import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { ExecutionAdapter } from './adapters.js';
import type { TradingSigner } from './signing/signer.js';
import { runPreflight, preflightLines, type PreflightResult } from './preflight.js';
import { recoverPendingOrders, reconcileAll } from './reconciler.js';
import { getLiveConfig, haltNetwork, stageCapUsd } from './riskEngine.js';
import { accountForMode, accountBook } from './accounts.js';
import { revocationCache } from './delegation/revocationCache.js';
import { expireDueGrants } from './delegation/grants.js';

// AUTONOMOUS SUPERVISOR.
//
// systemd restarts the process. This supervisor decides whether the process is
// allowed to resume trading once it is back — those are different jobs.
//
// Execution mode persists across restarts by design, so a crash at 3am does not
// silently demote a running network. But it does not resume blindly either: the
// boot sequence re-runs preflight, recovers any order that was in flight, and
// reconciles against the venue. Any failure auto-halts and waits for a human.

export interface BootReport {
  mode: string;
  preflight: PreflightResult | null;
  recovered: number;
  unresolved: number;
  reconciliationOk: boolean;
  halted: boolean;
  haltReason: string | null;
  lines: string[];
}

export class AutonomousSupervisor {
  private reconcileTimer: NodeJS.Timeout | null = null;
  private orderTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private hub: WsHub,
    private signer: TradingSigner,
    private adapters: Map<string, ExecutionAdapter>,
    private feedStatus: Record<string, { connected: boolean; stale: boolean }>,
    /** ETH/USD mark, so the gas-reserve check can price itself */
    private ethUsd?: () => number | null,
  ) {}

  /** the boot sequence — runs once, before the network is allowed to act */
  async boot(): Promise<BootReport> {
    const cfg = getLiveConfig(this.db);
    const lines: string[] = ['PUNKLABZ LIVE NETWORK'];
    const pad = (label: string, value: string) =>
      `${label} ${'.'.repeat(Math.max(2, 24 - label.length))} ${value}`;

    lines.push(pad('DATABASE', 'OK'));

    // Before anything else: the revocation cache fails closed, so an
    // un-hydrated cache would refuse every delegated order. Hydrate first, then
    // expire whatever lapsed while the process was down.
    revocationCache.hydrate(this.db);
    const expired = expireDueGrants(this.db);
    lines.push(pad('DELEGATION', `${revocationCache.size()} non-spendable${expired ? `, ${expired} expired on boot` : ''}`));

    const readiness = await this.signer.isReady();
    lines.push(pad('SIGNER', readiness.ready ? 'OK' : 'NOT CONFIGURED'));

    const account = accountForMode(this.db, cfg.mode);
    const book = accountBook(this.db, account.id, stageCapUsd(cfg.capitalStage));
    lines.push(pad('EXECUTION ACCOUNT', account.name));
    lines.push(pad('NAV', `$${book.navUsd.toFixed(2)}`));

    // 1. recover anything that was in flight when we stopped
    const recovery = await recoverPendingOrders(this.db, this.hub, this.adapters);
    lines.push(pad('PENDING ORDERS', recovery.unresolved > 0
      ? `${recovery.unresolved} UNRESOLVED`
      : `${recovery.recovered} recovered, 0 unresolved`));

    // 2. reconcile our books against every venue that can answer
    const passes = await reconcileAll(this.db, this.hub, this.adapters);
    const reconciliationOk = passes.every((p) => p.ok);
    lines.push(pad('RECONCILIATION', reconciliationOk ? 'CLEAN' : 'FAILED'));

    // 3. re-run preflight for whatever mode we woke up in
    let preflight: PreflightResult | null = null;
    if (cfg.mode !== 'simulation') {
      preflight = await runPreflight(
        {
          db: this.db, signer: this.signer, adapters: this.adapters, feedStatus: this.feedStatus,
          // no mark at boot means the gas check reports that it cannot price
          // the reserve, rather than quietly passing on an unpriced balance
          ethUsd: this.ethUsd?.() ?? null,
        },
        cfg.mode,
        'supervisor:boot',
      );
      lines.push(pad('PREFLIGHT', preflight.passed ? 'PASS' : 'FAIL'));
    }

    // 4. any failure means we come up halted, not trading
    const shouldHalt =
      recovery.unresolved > 0 || !reconciliationOk || (preflight !== null && !preflight.passed);
    if (shouldHalt && !cfg.halted) {
      const why = recovery.unresolved > 0
        ? `${recovery.unresolved} unresolved order(s) after restart`
        : !reconciliationOk
          ? 'reconciliation mismatch on boot'
          : `preflight failed: ${preflight?.blockers[0] ?? 'unknown'}`;
      haltNetwork(this.db, why, 'supervisor:boot');
    }

    const after = getLiveConfig(this.db);
    lines.push(pad('RISK ENGINE', 'ARMED'));
    lines.push(pad('KILL SWITCH', after.halted ? 'ENGAGED' : 'READY'));
    lines.push(pad('MODE', after.mode.toUpperCase()));
    lines.push(pad('CAPITAL STAGE', `$${stageCapUsd(after.capitalStage)}`));
    lines.push(after.halted ? 'NETWORK HALTED — OPERATOR REQUIRED' : 'AUTONOMOUS NETWORK ONLINE');

    for (const line of lines) console.log(line);

    return {
      mode: after.mode,
      preflight,
      recovered: recovery.recovered,
      unresolved: recovery.unresolved,
      reconciliationOk,
      halted: after.halted,
      haltReason: after.haltReason,
      lines,
    };
  }

  /** periodic duties once the network is up */
  startLoops(): void {
    // resolve orders the venue still owes us an answer on
    this.orderTimer = setInterval(() => {
      void this.pollPendingOrders().catch((e) => console.error('order poll failed:', e));
    }, 30_000);

    // full ledger-vs-venue reconciliation
    this.reconcileTimer = setInterval(() => {
      void reconcileAll(this.db, this.hub, this.adapters).catch((e) =>
        console.error('reconcile pass failed:', e),
      );
    }, 5 * 60_000);
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.orderTimer) clearInterval(this.orderTimer);
  }

  private async pollPendingOrders(): Promise<void> {
    const pending = this.db
      .prepare(
        `SELECT id, venue, venue_order_id FROM live_orders
         WHERE state IN ('submitted','pending','open','partial') AND venue_order_id IS NOT NULL`,
      )
      .all() as { id: number; venue: string; venue_order_id: string }[];

    for (const o of pending) {
      const adapter = this.adapters.get(o.venue);
      if (!adapter || typeof adapter.getOrderStatus !== 'function') continue;
      try {
        const status = await adapter.getOrderStatus(o.venue_order_id);
        if (status.state === 'unknown') continue;
        this.db
          .prepare(
            `UPDATE live_orders SET state = ?, filled_qty = ?,
             executed_price = COALESCE(?, executed_price), last_checked_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(status.state, status.filledQty, status.executedPrice ?? null, Date.now(), Date.now(), o.id);
        if (status.state === 'filled') {
          this.hub.publish('live', { event: 'order_resolved', orderId: o.id, state: status.state });
        }
      } catch (e) {
        console.error(`order status poll failed for ${o.id}:`, String(e).slice(0, 100));
      }
    }
  }
}

export { preflightLines };
