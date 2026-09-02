import { describe, expect, it, vi } from 'vitest';
import { WETH_ROBINHOOD } from '@punklabz/shared';
import { openTestDb } from '../src/db/db.js';
import { bindTraderWallet } from '../src/live/accounts.js';
import { CanaryExperimentCoordinator } from '../src/live/canaryExperiment.js';
import { insertRawAssetEntry } from '../src/live/rawAssetLedger.js';
import { getLiveConfig } from '../src/live/riskEngine.js';
import { signerPolicyFingerprint, type TradingSigner } from '../src/live/signing/signer.js';

const WALLET = '0x2C63C9161136Ee63f182303208B94c395ccBE115';
const RAW_WETH = 207_949_868_288_714n;

function guardedSigner(): TradingSigner {
  return {
    kind: 'test',
    async getAddress() { return WALLET; },
    async isReady() { return { ready: true, address: WALLET, detail: 'test' }; },
    async signTransaction() { throw new Error('recovery test must not sign directly'); },
    guards() {
      return {
        ownerEnforced: true,
        ownerId: 'owner_test',
        policyCount: 1,
        policyIds: ['policy_test'],
        signerId: 'signer_test',
        fullyGuarded: true,
      };
    },
  };
}

describe('canary experiment exit recovery', () => {
  it('resumes the exact receipt-derived sell without creating a second buy experiment', async () => {
    const db = openTestDb();
    const signer = guardedSigner();
    const account = bindTraderWallet(db, WALLET);
    getLiveConfig(db);
    db.prepare(
      `INSERT INTO bots (name,kind,strategy_type,config_json,status,created_at)
       VALUES ('PROBE','house','momentum','{}','running',1)`,
    ).run();
    const botId = Number((db.prepare(`SELECT id FROM bots WHERE name='PROBE'`).get() as { id: number }).id);
    db.prepare(
      `UPDATE live_config SET mode='canary', execution_phase='canary_probe', autonomy_enabled=0,
       halted=0, halt_reason=NULL, capital_stage=1 WHERE id=1`,
    ).run();

    const buy = db.prepare(
      `INSERT INTO live_orders
        (intent_id,execution_account_id,bot_id,instrument_id,venue,side,requested_notional_micro,
         approved_notional_micro,mode,state,operator_test,created_at,updated_at)
       VALUES ('probe-buy',?,?,'CRYPTO_SPOT://robinhood/WETH-USDG','evm:robinhood','buy',
         500000,500000,'canary','filled',1,1,1)`,
    ).run(account.id, botId);
    const buyOrderId = Number(buy.lastInsertRowid);
    insertRawAssetEntry(db, {
      executionAccountId: account.id,
      orderId: buyOrderId,
      chainId: 4663,
      symbol: 'WETH',
      contractAddress: WETH_ROBINHOOD.address,
      decimals: WETH_ROBINHOOD.decimals,
      rawDelta: RAW_WETH,
      eventType: 'fill',
      txRef: `0x${'11'.repeat(32)}`,
      logIndex: 7,
      snapshotHash: 'test',
    });
    db.prepare(
      `INSERT INTO canary_experiment_runs
        (execution_account_id,sponsor_bot_id,wallet_address,policy_fingerprint,state,buy_order_id,
         idempotency_key,failure_reason,actor,created_at,updated_at)
       VALUES (?,?,?,?,'failed',?,'original-round-trip','sell was risk_rejected: min_size',
         'operator:test',1,1)`,
    ).run(account.id, botId, WALLET.toLowerCase(), signerPolicyFingerprint(signer), buyOrderId);
    db.prepare(
      `INSERT INTO live_orders
        (intent_id,execution_account_id,bot_id,instrument_id,venue,side,requested_notional_micro,
         approved_notional_micro,mode,state,reject_reason,operator_test,experiment_run_id,created_at,updated_at)
       VALUES ('original-rejected-sell',?,?,'CRYPTO_SPOT://robinhood/WETH-USDG','evm:robinhood','sell',
         499125,0,'canary','risk_rejected','min_size',1,1,1,1)`,
    ).run(account.id, botId);

    const forceTrade = vi.fn(async (params: any) => {
      expect(params.side).toBe('sell');
      expect(params.exactSellQuantity).toBeCloseTo(0.000207949868288714, 18);
      expect(params.idempotencyKey).toBe('original-round-trip:sell:recovery:v1');
      const sell = db.prepare(
        `INSERT INTO live_orders
          (intent_id,execution_account_id,bot_id,instrument_id,venue,side,requested_notional_micro,
           approved_notional_micro,mode,state,operator_test,experiment_run_id,created_at,updated_at)
         VALUES ('probe-sell',?,?,'CRYPTO_SPOT://robinhood/WETH-USDG','evm:robinhood','sell',
           499125,499125,'canary','pending',1,1,2,2)`,
      ).run(account.id, botId);
      return { orderId: Number(sell.lastInsertRowid), state: 'pending', detail: 'submitted' };
    });
    const coordinator = new CanaryExperimentCoordinator(
      db,
      { publish: vi.fn() } as any,
      signer,
      new Map(),
      { forceTrade } as any,
    );

    expect(await coordinator.canRecoverExactExit()).toBe(true);
    const result = await coordinator.start(botId, 'recovery-request', 'operator:test');

    expect(forceTrade).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: 1, state: 'sell_pending', buyOrderId, failureReason: null });
    expect(result.sellOrderId).toBeTruthy();
    expect((db.prepare(`SELECT COUNT(*) n FROM canary_experiment_runs`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) n FROM live_orders WHERE side='buy'`).get() as { n: number }).n).toBe(1);
  });
});
