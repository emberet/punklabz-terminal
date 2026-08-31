import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { ExecutionAdapter } from './adapters.js';
import type { TradingSigner } from './signing/signer.js';
import { runPreflight, preflightLines, type PreflightResult } from './preflight.js';
import { recoverPendingOrders, reconcileAll } from './reconciler.js';
import { getLiveConfig, haltNetwork, resumeAfterSafetyChecks, setCapitalStage, setLiveMode, stageCapUsd } from './riskEngine.js';
import { accountForMode, accountBook } from './accounts.js';
import { bindTraderWallet } from './accounts.js';
import { revocationCache } from './delegation/revocationCache.js';
import { expireDueGrants } from './delegation/grants.js';
import { settleConfirmedOrder } from './settlement.js';
import type { ExecutionMode } from '@punklabz/shared';

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

  /**
   * Poll until at least one feed reports connected and not stale, or the
   * deadline passes. Returns whether market data arrived; the caller still
   * lets preflight make the actual decision, so a timeout produces a normal
   * blocking failure rather than a special case.
   */
  private async awaitMarketData(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const feeds = Object.values(this.feedStatus);
      if (feeds.length > 0 && feeds.some((f) => f.connected && !f.stale)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** the boot sequence — runs once, before the network is allowed to act */
  async boot(): Promise<BootReport> {
    const cfg = getLiveConfig(this.db);
    const lines: string[] = ['PUNKLABZ LIVE NETWORK'];
    const pad = (label: string, value: string) =>
      `${label} ${'.'.repeat(Math.max(2, 24 - label.length))} ${value}`;

    lines.push(pad('DATABASE', 'OK'));

    // WAIT FOR MARKET DATA BEFORE JUDGING IT.
    //
    // Feeds connect asynchronously. Running preflight the instant the process
    // starts guaranteed `market_data: no feeds reporting yet`, which halted the
    // network on EVERY restart in canary or live — for a condition that was
    // merely early, not wrong. "Not yet" and "down" are different answers and
    // only one of them should stop trading.
    //
    // After the timeout it IS a real failure and preflight says so.
    if (cfg.mode === 'canary' || cfg.mode === 'live') {
      const connected = await this.awaitMarketData(30_000);
      lines.push(pad('MARKET DATA', connected ? 'CONNECTED' : 'NOT REPORTING'));
    }

    // Before anything else: the revocation cache fails closed, so an
    // un-hydrated cache would refuse every delegated order. Hydrate first, then
    // expire whatever lapsed while the process was down.
    revocationCache.hydrate(this.db);
    const expired = expireDueGrants(this.db);
    lines.push(pad('DELEGATION', `${revocationCache.size()} non-spendable${expired ? `, ${expired} expired on boot` : ''}`));

    const readiness = await this.signer.isReady();
    lines.push(pad('SIGNER', readiness.ready ? 'OK' : 'NOT CONFIGURED'));
    if (readiness.address) {
      try {
        bindTraderWallet(this.db, readiness.address);
      } catch (error) {
        haltNetwork(this.db, `execution wallet isolation failed: ${String(error)}`, 'supervisor:boot');
      }
    }

    const account = accountForMode(this.db, cfg.mode);
    const book = accountBook(this.db, account.id, stageCapUsd(cfg.capitalStage));
    lines.push(pad('EXECUTION ACCOUNT', account.name));
    lines.push(pad('NAV', `$${book.navUsd.toFixed(2)}`));

    // 1. recover the durable signed/broadcast transactions first. An order row
    // may not have received its hash if the process died immediately after RPC
    // broadcast, but execution_transactions already has the signed bytes.
    let txRecovered = 0;
    let txUnresolved = 0;
    for (const adapter of this.adapters.values()) {
      if (typeof adapter.recoverTransactions !== 'function') continue;
      const recovered = await adapter.recoverTransactions();
      txRecovered += recovered.recovered;
      txUnresolved += recovered.unresolved;
    }
    lines.push(pad('TRANSACTIONS', `${txRecovered} recovered, ${txUnresolved} unresolved`));

    // 2. recover anything that was in flight when we stopped
    const recovery = await recoverPendingOrders(this.db, this.hub, this.adapters);
    lines.push(pad('PENDING ORDERS', recovery.unresolved > 0
      ? `${recovery.unresolved} UNRESOLVED`
      : `${recovery.recovered} recovered, 0 unresolved`));

    // 3. reconcile our books against every venue that can answer
    const realMode = cfg.mode === 'canary' || cfg.mode === 'live';
    const passes = await reconcileAll(this.db, this.hub, this.adapters, { includeCustody: realMode });
    const reconciliationOk = passes.every((p) => p.ok);
    lines.push(pad('RECONCILIATION', reconciliationOk ? 'CLEAN' : 'FAILED'));

    // 4. re-run preflight for whatever mode we woke up in
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

    // 5. any failure means we come up halted, not trading
    const shouldHalt =
      txUnresolved > 0 || recovery.unresolved > 0 || !reconciliationOk || (preflight !== null && !preflight.passed);
    if (shouldHalt && !cfg.halted) {
      const why = txUnresolved > 0
        ? `${txUnresolved} unresolved transaction(s) after restart`
        : recovery.unresolved > 0
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

  /** Manual arming is a fresh boot gate, never a bit-flip of `halted`. */
  async arm(targetMode: ExecutionMode, stage: number, actor: string): Promise<PreflightResult> {
    if (targetMode !== 'canary' && targetMode !== 'live') {
      throw new Error('arm target must be canary or live');
    }
    if (targetMode === 'canary' && stage < 1) throw new Error('canary starts at the $5 stage');
    if (targetMode === 'live' && stage !== 4) throw new Error('live mode requires the $100 stage');

    const preflight = await this.safetyGate(targetMode, stage, actor);

    this.db.transaction(() => {
      setCapitalStage(this.db, stage, actor);
      setLiveMode(this.db, targetMode, actor, preflight);
      resumeAfterSafetyChecks(this.db, actor, {
        transactionsRecovered: true, reconciliationClean: true, preflightPassed: true,
      });
    })();
    this.hub.publish('live', { event: 'armed', mode: targetMode, stage });
    return preflight;
  }

  /** Shadow can be resumed without custody infrastructure because it cannot sign. */
  async armShadow(actor: string): Promise<PreflightResult> {
    let unresolved = 0;
    for (const adapter of this.adapters.values()) {
      if (typeof adapter.recoverTransactions !== 'function') continue;
      unresolved += (await adapter.recoverTransactions()).unresolved;
    }
    const orders = await recoverPendingOrders(this.db, this.hub, this.adapters);
    if (unresolved + orders.unresolved > 0) {
      throw new Error(`${unresolved + orders.unresolved} transaction/order outcome(s) unresolved`);
    }
    const preflight = await runPreflight({
      db: this.db, signer: this.signer, adapters: this.adapters, feedStatus: this.feedStatus,
      ethUsd: this.ethUsd?.() ?? null,
    }, 'shadow', actor);
    if (!preflight.passed) throw new Error(`shadow preflight failed: ${preflight.blockers.join('; ')}`);
    this.db.transaction(() => {
      setLiveMode(this.db, 'shadow', actor, preflight);
      resumeAfterSafetyChecks(this.db, actor, {
        transactionsRecovered: true, reconciliationClean: true, preflightPassed: true,
      });
      this.db.prepare(`UPDATE live_config SET shadow_armed_at=?, updated_at=? WHERE id=1`)
        .run(Date.now(), Date.now());
    })();
    this.hub.publish('live', { event: 'armed', mode: 'shadow' });
    return preflight;
  }

  /** Promotion uses the same fresh evidence as arming, with no stale-recon shortcut. */
  async promoteStage(stage: number, actor: string): Promise<PreflightResult | null> {
    const cfg = getLiveConfig(this.db);
    if (stage <= cfg.capitalStage) {
      setCapitalStage(this.db, stage, actor);
      return null;
    }
    if (cfg.mode !== 'canary' && cfg.mode !== 'live') {
      throw new Error('capital promotion requires an armed canary or live network');
    }
    const preflight = await this.safetyGate(cfg.mode, stage, actor);
    setCapitalStage(this.db, stage, actor);
    this.hub.publish('live', { event: 'stage_change', stage });
    return preflight;
  }

  private async safetyGate(targetMode: ExecutionMode, stage: number, actor: string): Promise<PreflightResult> {
    let unresolved = 0;
    for (const adapter of this.adapters.values()) {
      if (typeof adapter.recoverTransactions !== 'function') continue;
      unresolved += (await adapter.recoverTransactions()).unresolved;
    }
    const orders = await recoverPendingOrders(this.db, this.hub, this.adapters);
    if (unresolved + orders.unresolved > 0) {
      throw new Error(`${unresolved + orders.unresolved} transaction/order outcome(s) unresolved`);
    }
    const passes = await reconcileAll(this.db, this.hub, this.adapters);
    if (!passes.every((p) => p.ok)) throw new Error('reconciliation failed; network remains halted');

    const preflight = await runPreflight({
      db: this.db, signer: this.signer, adapters: this.adapters, feedStatus: this.feedStatus,
      ethUsd: this.ethUsd?.() ?? null,
    }, targetMode, actor, { targetStage: stage });
    if (!preflight.passed) throw new Error(`preflight failed: ${preflight.blockers.join('; ')}`);
    return preflight;
  }

  /** periodic duties once the network is up */
  startLoops(): void {
    // resolve orders the venue still owes us an answer on
    this.orderTimer = setInterval(() => {
      void this.pollPendingOrders().catch((e) => console.error('order poll failed:', e));
    }, 30_000);

    // full ledger-vs-venue reconciliation
    this.reconcileTimer = setInterval(() => {
      const cfg = getLiveConfig(this.db);
      const realMode = cfg.mode === 'canary' || cfg.mode === 'live';
      void reconcileAll(this.db, this.hub, this.adapters, { includeCustody: realMode }).catch((e) =>
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
      `SELECT id, venue, venue_order_id, mode FROM live_orders
         WHERE state IN ('submitted','pending','open','partial') AND venue_order_id IS NOT NULL`,
      )
      .all() as { id: number; venue: string; venue_order_id: string; mode: string }[];

    for (const o of pending) {
      const adapter = this.adapters.get(o.venue);
      if (!adapter || typeof adapter.getOrderStatus !== 'function') continue;
      try {
        const status = await adapter.getOrderStatus(o.venue_order_id);
        if (status.state === 'unknown') {
          this.db.prepare(
            `UPDATE live_orders SET state='reconciling', reject_reason=?, last_checked_at=?, updated_at=? WHERE id=?`,
          ).run(status.detail, Date.now(), Date.now(), o.id);
          if (o.mode === 'canary' || o.mode === 'live') {
            haltNetwork(this.db, `order ${o.id} transaction outcome is ambiguous: ${status.detail}`, 'supervisor');
          }
          continue;
        }
        if (status.state === 'filled' && (o.mode === 'canary' || o.mode === 'live')) {
          settleConfirmedOrder(this.db, o.id, status);
        } else {
          this.db
            .prepare(
              `UPDATE live_orders SET state = ?, filled_qty = ?,
               executed_price = COALESCE(?, executed_price), last_checked_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(status.state, status.filledQty, status.executedPrice ?? null, Date.now(), Date.now(), o.id);
        }
        if (status.state === 'filled') {
          this.hub.publish('live', { event: 'order_resolved', orderId: o.id, state: status.state });
        } else if ((status.state === 'failed' || status.state === 'cancelled')
          && (o.mode === 'canary' || o.mode === 'live')) {
          haltNetwork(this.db, `order ${o.id} transaction ended ${status.state}: ${status.detail}`, 'supervisor');
        }
      } catch (e) {
        console.error(`order status poll failed for ${o.id}:`, String(e).slice(0, 100));
        haltNetwork(this.db, `order ${o.id} receipt could not be settled: ${String(e).slice(0, 120)}`, 'supervisor');
      }
    }
  }
}

export { preflightLines };
