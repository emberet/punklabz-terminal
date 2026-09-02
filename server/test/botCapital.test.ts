import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/db.js';
import { accountForMode, setBotAllocation } from '../src/live/accounts.js';
import { liveBotCapital } from '../src/live/botCapital.js';
import { botSummaries } from '../src/api/queries.js';

describe('live bot capital view', () => {
  it('keeps paper equity separate from receipt-derived live allocation', () => {
    const db = openTestDb();
    const botId = Number(db.prepare(
      `INSERT INTO bots (name,kind,strategy_type,config_json,status,created_at)
       VALUES ('MOMENTUM RUNNER','house','momentum','{}','running',1)`,
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO bot_accounts (bot_id,cash_micro,initial_balance_micro,updated_at)
       VALUES (?,10000000000,10000000000,1)`,
    ).run(botId);
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    setBotAllocation(db, account.id, botId, 0.5, 'test', 5);
    const orderId = Number(db.prepare(
      `INSERT INTO live_orders
        (intent_id,execution_account_id,bot_id,instrument_id,venue,side,requested_notional_micro,
         approved_notional_micro,expected_price,mode,state,capital_stage,created_at,updated_at)
       VALUES ('live-capital-test',?,?,'CRYPTO_SPOT://robinhood/WETH-USDG','evm:robinhood','buy',
         500000,500000,2400,'canary','filled',1,1,1)`,
    ).run(account.id, botId).lastInsertRowid);
    db.prepare(
      `INSERT INTO execution_asset_ledger
        (execution_account_id,order_id,asset,qty_delta,event_type,ts)
       VALUES (?,?,'USDG','-0.5','fill',1), (?,?,'WETH','0.0002','fill',1)`,
    ).run(account.id, orderId, account.id, orderId);
    db.prepare(
      `INSERT INTO live_ledger
        (order_id,execution_account_id,bot_id,instrument_id,venue,side,qty,expected_price,
         executed_price,fee_micro,gas_micro,realized_pnl_micro,mode,ts)
       VALUES (?,?,?,'CRYPTO_SPOT://robinhood/WETH-USDG','evm:robinhood','buy',0.0002,
         2400,2400,0,10000,0,'canary',1)`,
    ).run(orderId, account.id, botId);
    db.prepare(
      `INSERT INTO reconciliation_runs
        (execution_account_id,started_at,completed_at,status,detail,actor)
       VALUES (?,1,2,'clean','matched','test')`,
    ).run(account.id);

    const view = liveBotCapital(db, botId, (symbol) => symbol === 'ETHUSDT' ? 2500 : undefined)!;
    expect(view).toMatchObject({ allocatedUsd: 0.5, cashUsd: 0, exposureUsd: 0.5, navUsd: 0.5,
      netPnlUsd: -0.01, fillCount: 1, reconciliationStatus: 'clean' });
    expect(view.holdings.WETH).toBe(0.0002);

    const summary = botSummaries(db, (symbol) => symbol === 'ETHUSDT' ? 2500 : undefined)[0];
    expect(summary.equityUsd).toBe(10_000);
    expect(summary.liveCapital?.navUsd).toBe(0.5);
  });
});
