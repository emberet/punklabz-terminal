import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import { appendAudit } from '../audit/auditLog.js';
import { alertOperator } from '../ops/alerts.js';
import type { ExecutionAdapter } from './adapters.js';
import { rawHoldings } from './rawAssetLedger.js';
import {
  accountForMode, custodyHoldings, setBotAllocation,
} from './accounts.js';
import type { LiveNetwork } from './liveNetwork.js';
import { reconcileAccount } from './reconciler.js';
import { getLiveConfig, haltNetwork, stageCapUsd } from './riskEngine.js';
import type { TradingSigner } from './signing/signer.js';
import { signerPolicyFingerprint } from './signing/signer.js';
import { WETH_ROBINHOOD } from '@punklabz/shared';
import { formatUnits } from 'viem';

export interface CanaryExperimentView {
  id: number;
  state: string;
  sponsorBotId: number;
  walletAddress: string;
  buyOrderId: number | null;
  sellOrderId: number | null;
  reconciliationRunId: number | null;
  idempotencyKey: string;
  failureReason: string | null;
  createdAt: number;
  completedAt: number | null;
  updatedAt: number;
}

function view(row: any): CanaryExperimentView {
  return {
    id: row.id,
    state: row.state,
    sponsorBotId: row.sponsor_bot_id,
    walletAddress: row.wallet_address,
    buyOrderId: row.buy_order_id,
    sellOrderId: row.sell_order_id,
    reconciliationRunId: row.reconciliation_run_id,
    idempotencyKey: row.idempotency_key,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

/** Durable, restart-safe proof trade for the isolated stage-1 canary. */
export class CanaryExperimentCoordinator {
  private advancing = false;

  constructor(
    private db: DB,
    private hub: WsHub,
    private signer: TradingSigner,
    private adapters: Map<string, ExecutionAdapter>,
    private liveNetwork: LiveNetwork,
  ) {}

  latest(): CanaryExperimentView | null {
    const row = this.db.prepare(`SELECT * FROM canary_experiment_runs ORDER BY id DESC LIMIT 1`).get();
    return row ? view(row) : null;
  }

  private recoveryCandidate(
    accountId: number,
    wallet: string,
    policy: string,
    sponsorBotId?: number,
  ): { row: any; receivedRaw: bigint } | null {
    const row = this.db.prepare(
      `SELECT r.* FROM canary_experiment_runs r
       JOIN live_orders b ON b.id=r.buy_order_id
       WHERE r.state='failed' AND r.execution_account_id=?
         AND (? IS NULL OR r.sponsor_bot_id=?)
         AND lower(r.wallet_address)=lower(?) AND r.policy_fingerprint=?
         AND r.sell_order_id IS NULL AND r.failure_reason='sell was risk_rejected: min_size'
         AND b.state='filled' AND b.operator_test=1
       ORDER BY r.id DESC LIMIT 1`,
    ).get(accountId, sponsorBotId ?? null, sponsorBotId ?? null, wallet, policy) as any;
    if (!row) return null;
    const unresolvedTransactions = (this.db.prepare(
      `SELECT COUNT(*) n FROM execution_transactions
       WHERE state IN ('prepared','signed','broadcast','unknown')`,
    ).get() as { n: number }).n;
    const unresolvedOrders = (this.db.prepare(
      `SELECT COUNT(*) n FROM live_orders
       WHERE state IN ('risk_approved','submitting','submitted','pending','open','partial','reconciling')`,
    ).get() as { n: number }).n;
    const receivedRows = this.db.prepare(
      `SELECT raw_delta FROM execution_asset_ledger
       WHERE execution_account_id=? AND order_id=? AND lower(contract_address)=lower(?)
         AND event_type='fill' AND raw_delta IS NOT NULL`,
    ).all(accountId, row.buy_order_id, WETH_ROBINHOOD.address) as { raw_delta: string }[];
    const receivedRaw = receivedRows.reduce((sum, entry) => {
      const delta = BigInt(entry.raw_delta);
      return delta > 0n ? sum + delta : sum;
    }, 0n);
    const heldRaw = rawHoldings(this.db, accountId).get(WETH_ROBINHOOD.address.toLowerCase()) ?? 0n;
    return unresolvedTransactions === 0 && unresolvedOrders === 0 && receivedRaw > 0n && heldRaw === receivedRaw
      ? { row, receivedRaw }
      : null;
  }

  async canRecoverExactExit(): Promise<boolean> {
    const cfg = getLiveConfig(this.db);
    if (cfg.mode !== 'canary' || cfg.capitalStage !== 1 || cfg.autonomyEnabled) return false;
    const wallet = await this.signer.getAddress();
    const policy = signerPolicyFingerprint(this.signer);
    if (!wallet || !policy) return false;
    const account = accountForMode(this.db, 'canary', 'evm:robinhood');
    if (!account.walletAddress || account.walletAddress.toLowerCase() !== wallet.toLowerCase()) return false;
    return this.recoveryCandidate(account.id, wallet, policy) !== null;
  }

  async start(sponsorBotId: number, idempotencyKey: string, actor: string): Promise<CanaryExperimentView> {
    const existing = this.db.prepare(`SELECT * FROM canary_experiment_runs WHERE idempotency_key=?`)
      .get(idempotencyKey);
    if (existing) {
      await this.advance();
      return this.byId((existing as any).id)!;
    }

    const cfg = getLiveConfig(this.db);
    const validPhase = cfg.phase === 'canary_probe' || cfg.phase === 'canary_exit_recovery';
    if (cfg.mode !== 'canary' || !validPhase || cfg.autonomyEnabled || cfg.halted || cfg.capitalStage !== 1) {
      throw new Error('round-trip probe requires an active, non-autonomous stage-1 canary probe');
    }
    const active = this.db.prepare(
      `SELECT id FROM canary_experiment_runs WHERE state NOT IN ('completed','failed') LIMIT 1`,
    ).get() as { id: number } | undefined;
    if (active) throw new Error(`canary experiment ${active.id} is already active`);

    const bot = this.db.prepare(`SELECT id FROM bots WHERE id=? AND status IN ('running','paused')`)
      .get(sponsorBotId);
    if (!bot) throw new Error(`sponsor bot ${sponsorBotId} is not active`);
    const wallet = await this.signer.getAddress();
    const policy = signerPolicyFingerprint(this.signer);
    if (!wallet || !policy) throw new Error('exact guarded Trader signer policy is required');
    const account = accountForMode(this.db, 'canary', 'evm:robinhood');
    if (!account.walletAddress || account.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
      throw new Error('Trader account and signer wallet do not match');
    }

    const recovery = this.recoveryCandidate(account.id, wallet, policy, sponsorBotId);
    if (recovery) {
      const recoverable = recovery.row;
      this.db.prepare(
        `UPDATE canary_experiment_runs
         SET state='buy_confirmed', failure_reason=NULL, updated_at=? WHERE id=? AND state='failed'`,
      ).run(Date.now(), recoverable.id);
      appendAudit(this.db, actor, 'live_canary_experiment_exit_recovery', {
        experimentRunId: recoverable.id,
        buyOrderId: recoverable.buy_order_id,
        receivedRaw: recovery.receivedRaw.toString(),
        requestIdempotencyKey: idempotencyKey,
      });
      await this.advance();
      return this.byId(recoverable.id)!;
    }
    if (cfg.phase === 'canary_exit_recovery') {
      throw new Error('exit-only recovery requires an exact stranded probe position and no unresolved work');
    }

    const capital = Math.min(stageCapUsd(cfg.capitalStage), custodyHoldings(this.db, account.id).get('USDG') ?? 0);
    setBotAllocation(this.db, account.id, sponsorBotId, 0.5, actor, capital);

    const now = Date.now();
    const info = this.db.prepare(
      `INSERT INTO canary_experiment_runs
        (execution_account_id, sponsor_bot_id, wallet_address, policy_fingerprint, state,
         idempotency_key, actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
    ).run(account.id, sponsorBotId, wallet.toLowerCase(), policy, idempotencyKey, actor, now, now);
    const id = Number(info.lastInsertRowid);
    appendAudit(this.db, actor, 'live_canary_experiment_started', {
      experimentRunId: id, sponsorBotId, walletAddress: wallet.toLowerCase(), notionalUsd: 0.5,
    });
    await this.advance();
    return this.byId(id)!;
  }

  async advance(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      const rows = this.db.prepare(
        `SELECT * FROM canary_experiment_runs WHERE state NOT IN ('completed','failed') ORDER BY id`,
      ).all() as any[];
      for (const row of rows) await this.advanceOne(row);
    } finally {
      this.advancing = false;
    }
  }

  private byId(id: number): CanaryExperimentView | null {
    const row = this.db.prepare(`SELECT * FROM canary_experiment_runs WHERE id=?`).get(id);
    return row ? view(row) : null;
  }

  private fail(row: any, reason: string): void {
    const detail = reason.slice(0, 300);
    this.db.prepare(
      `UPDATE canary_experiment_runs SET state='failed', failure_reason=?, updated_at=? WHERE id=?`,
    ).run(detail, Date.now(), row.id);
    appendAudit(this.db, 'canary-experiment', 'live_canary_experiment_failed', {
      experimentRunId: row.id, reason: detail,
    });
    haltNetwork(this.db, `canary experiment ${row.id} failed: ${detail}`, 'canary-experiment');
  }

  private async advanceOne(row: any): Promise<void> {
    const cfg = getLiveConfig(this.db);
    const validPhase = cfg.phase === 'canary_probe' || cfg.phase === 'canary_exit_recovery';
    if (cfg.mode !== 'canary' || !validPhase || cfg.autonomyEnabled) return;
    if (cfg.halted) return;

    if (row.state === 'created') {
      const result = await this.liveNetwork.forceTrade({
        botId: row.sponsor_bot_id,
        symbol: 'ETHUSDT',
        side: 'buy',
        notionalUsd: 0.5,
        actor: row.actor,
        idempotencyKey: `${row.idempotency_key}:buy`,
        experimentRunId: row.id,
      });
      if (!result.orderId || !['pending', 'filled'].includes(result.state)) {
        this.fail(row, `buy was ${result.state}: ${result.detail}`);
        return;
      }
      this.db.prepare(
        `UPDATE canary_experiment_runs SET state='buy_pending', buy_order_id=?, updated_at=? WHERE id=?`,
      ).run(result.orderId, Date.now(), row.id);
      this.hub.publish('live', { event: 'canary_probe_buy', experimentRunId: row.id, orderId: result.orderId });
      return;
    }

    if (row.state === 'buy_pending') {
      const order = this.db.prepare(`SELECT state, reject_reason FROM live_orders WHERE id=?`).get(row.buy_order_id) as
        { state: string; reject_reason: string | null } | undefined;
      if (!order || ['failed', 'cancelled', 'risk_rejected', 'reconciling'].includes(order.state)) {
        this.fail(row, `buy order did not settle cleanly: ${order?.reject_reason ?? order?.state ?? 'missing'}`);
        return;
      }
      if (order.state !== 'filled') return;
      this.db.prepare(
        `UPDATE canary_experiment_runs SET state='buy_confirmed', updated_at=? WHERE id=?`,
      ).run(Date.now(), row.id);
      row.state = 'buy_confirmed';
    }

    if (row.state === 'buy_confirmed') {
      const receivedRows = this.db.prepare(
        `SELECT raw_delta FROM execution_asset_ledger
         WHERE execution_account_id=? AND order_id=? AND lower(contract_address)=lower(?)
           AND event_type='fill' AND raw_delta IS NOT NULL`,
      ).all(row.execution_account_id, row.buy_order_id, WETH_ROBINHOOD.address) as { raw_delta: string }[];
      const receivedRaw = receivedRows.reduce((sum, entry) => {
        const delta = BigInt(entry.raw_delta);
        return delta > 0n ? sum + delta : sum;
      }, 0n);
      if (receivedRaw <= 0n) {
        this.fail(row, 'confirmed buy receipt contains no positive WETH delta');
        return;
      }
      const receivedQty = Number(formatUnits(receivedRaw, WETH_ROBINHOOD.decimals));
      const result = await this.liveNetwork.forceTrade({
        botId: row.sponsor_bot_id,
        symbol: 'ETHUSDT',
        side: 'sell',
        notionalUsd: 0.5,
        exactSellQuantity: receivedQty,
        actor: row.actor,
        idempotencyKey: `${row.idempotency_key}:sell`,
        experimentRunId: row.id,
      });
      if (!result.orderId || !['pending', 'filled'].includes(result.state)) {
        this.fail(row, `sell was ${result.state}: ${result.detail}`);
        return;
      }
      this.db.prepare(
        `UPDATE canary_experiment_runs SET state='sell_pending', sell_order_id=?, updated_at=? WHERE id=?`,
      ).run(result.orderId, Date.now(), row.id);
      this.hub.publish('live', { event: 'canary_probe_sell', experimentRunId: row.id, orderId: result.orderId });
      return;
    }

    if (row.state === 'sell_pending') {
      const order = this.db.prepare(`SELECT state, reject_reason FROM live_orders WHERE id=?`).get(row.sell_order_id) as
        { state: string; reject_reason: string | null } | undefined;
      if (!order || ['failed', 'cancelled', 'risk_rejected', 'reconciling'].includes(order.state)) {
        this.fail(row, `sell order did not settle cleanly: ${order?.reject_reason ?? order?.state ?? 'missing'}`);
        return;
      }
      if (order.state !== 'filled') return;
      this.db.prepare(
        `UPDATE canary_experiment_runs SET state='reconciling', updated_at=? WHERE id=?`,
      ).run(Date.now(), row.id);
      row.state = 'reconciling';
    }

    if (row.state === 'reconciling') {
      const account = accountForMode(this.db, 'canary', 'evm:robinhood');
      const adapter = this.adapters.get(account.venue);
      if (!adapter) {
        this.fail(row, `missing ${account.venue} adapter`);
        return;
      }
      const pass = await reconcileAccount(this.db, this.hub, account.id, adapter);
      if (!pass.ok || !pass.runId) {
        this.fail(row, `round-trip reconciliation failed: ${pass.detail}`);
        return;
      }
      const residualWeth = custodyHoldings(this.db, account.id).get('WETH') ?? 0;
      if (Math.abs(residualWeth) > 1e-12) {
        this.fail(row, `round-trip left ${residualWeth} WETH in the Trader account`);
        return;
      }
      const now = Date.now();
      this.db.prepare(
        `UPDATE canary_experiment_runs SET state='completed', reconciliation_run_id=?,
         completed_at=?, updated_at=? WHERE id=?`,
      ).run(pass.runId, now, now, row.id);
      appendAudit(this.db, row.actor, 'live_canary_experiment_completed', {
        experimentRunId: row.id, buyOrderId: row.buy_order_id,
        sellOrderId: row.sell_order_id, reconciliationRunId: pass.runId,
      });
      alertOperator('live_canary_experiment_completed', `canary round trip ${row.id} reconciled cleanly`);
      this.hub.publish('live', {
        event: 'canary_probe_complete', experimentRunId: row.id, reconciliationRunId: pass.runId,
      });
      if (cfg.phase === 'canary_exit_recovery') {
        this.db.prepare(`UPDATE live_config SET execution_phase='canary_probe', updated_at=? WHERE id=1`)
          .run(Date.now());
        haltNetwork(this.db, 'receipt-derived canary exit completed; fresh collateralization and arm required', 'canary-experiment');
      }
    }
  }
}
