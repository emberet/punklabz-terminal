import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  accountForMode, bindTraderWallet, custodyHoldings, recordCustodyTransfer,
  recordFunding, separateManagerAndTrader, setBotAllocation,
} from '../src/live/accounts.js';
import { TransactionCoordinator } from '../src/live/transactionCoordinator.js';
import { settleConfirmedOrder } from '../src/live/settlement.js';
import { reconcileAccount } from '../src/live/reconciler.js';
import type { TradingSigner } from '../src/live/signing/signer.js';
import { evaluateIntent, getLiveConfig } from '../src/live/riskEngine.js';
import { runPreflight } from '../src/live/preflight.js';
import {
  buildManagerFundingPolicy, buildManagerGasTopUpPolicy, buildPolicy, USDG_ADDRESS, WETH_ADDRESS,
  ZEROX_ALLOWANCE_HOLDER,
} from '../src/live/signing/provisionPrivy.js';
import { LiveNetwork } from '../src/live/liveNetwork.js';
import { parseIndexedEthFunding, ZeroXRobinhoodAdapter } from '../src/live/adapters/zeroXRobinhood.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';

describe('isolated Manager to Trader custody', () => {
  it('does not capitalize the Trader until a confirmed transfer is recorded exactly once', () => {
    const db = openTestDb();
    const funded = bindTraderWallet(db, WALLET);
    recordFunding(db, funded.id, [
      { asset: 'USDG', qty: 10, txRef: `0x${'01'.repeat(32)}`, logIndex: 0 },
      { asset: 'ETH', qty: 0.01, txRef: `0x${'02'.repeat(32)}`, logIndex: -1 },
    ], 'test');
    const accounts = separateManagerAndTrader(db, TARGET, 'test');

    expect(custodyHoldings(db, accounts.manager.id).get('USDG')).toBe(10);
    expect(custodyHoldings(db, accounts.trader.id).get('USDG') ?? 0).toBe(0);

    const txRef = `0x${'03'.repeat(32)}`;
    const first = recordCustodyTransfer(db, {
      fromAccountId: accounts.manager.id, toAccountId: accounts.trader.id,
      asset: 'USDG', qty: 5, txRef, logIndex: 7, confirmations: 12,
    }, 'test');
    const replay = recordCustodyTransfer(db, {
      fromAccountId: accounts.manager.id, toAccountId: accounts.trader.id,
      asset: 'USDG', qty: 5, txRef, logIndex: 7, confirmations: 12,
    }, 'test');

    expect(replay).toBe(first);
    expect(custodyHoldings(db, accounts.manager.id).get('USDG')).toBe(5);
    expect(custodyHoldings(db, accounts.trader.id).get('USDG')).toBe(5);
    expect((db.prepare(`SELECT COUNT(*) n FROM custody_transfers`).get() as any).n).toBe(1);
  });

  it('builds a temporary Manager policy for only the exact seed transfers', () => {
    const policy = buildManagerFundingPolicy(TARGET) as any;
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules[0].conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'chain_id', value: '4663' }),
      expect.objectContaining({ field: 'to', value: USDG_ADDRESS }),
      expect.objectContaining({ field: 'transfer.to', value: TARGET }),
      expect.objectContaining({ field: 'transfer.amount', value: '0x4C4B40' }),
    ]));
    expect(policy.rules[1].conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'chain_id', value: '4663' }),
      expect.objectContaining({ field: 'to', value: TARGET }),
      expect.objectContaining({ field: 'value', value: '0x11C37937E08000' }),
    ]));
  });

  it('builds a temporary Manager policy for one exact bounded gas top-up', () => {
    const policy = buildManagerGasTopUpPolicy(TARGET, '0.002') as any;
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].conditions).toEqual([
      expect.objectContaining({ field: 'chain_id', value: '4663' }),
      expect.objectContaining({ field: 'to', value: TARGET }),
      expect.objectContaining({ field: 'value', value: '0x71AFD498D0000' }),
    ]);
    expect(() => buildManagerGasTopUpPolicy(TARGET, '0')).toThrow(/greater than 0/);
    expect(() => buildManagerGasTopUpPolicy(TARGET, '0.011')).toThrow(/no more than 0.01/);
  });
});

describe('historical native funding proofs', () => {
  it('accepts only a successful trace into the exact wallet and transaction', () => {
    const hash = `0x${'12'.repeat(32)}`;
    const transfers = parseIndexedEthFunding({ items: [
      { index: 3, txHash: hash, blockNumber: 123, to: WALLET, value: '2024330000000000', success: true },
      { index: 4, txHash: hash, blockNumber: 123, to: TARGET, value: '999', success: true },
      { index: 5, txHash: hash, blockNumber: 123, to: WALLET, value: '999', success: false },
    ] }, hash, WALLET);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      asset: 'ETH', qty: 0.00202433, txRef: hash, logIndex: 3, blockNumber: 123n,
      valueWei: 2024330000000000n,
    });
  });

  it('rejects malformed trace evidence', () => {
    const hash = `0x${'34'.repeat(32)}`;
    expect(() => parseIndexedEthFunding({ items: [
      { index: -1, txHash: hash, blockNumber: 123, to: WALLET, value: '1', success: true },
    ] }, hash, WALLET)).toThrow(/malformed ETH transfer/);
  });
});

function insertOrder(db: DB, accountId: number, intent = 'safety-order'): number {
  const info = db.prepare(
    `INSERT INTO live_orders
      (intent_id, execution_account_id, instrument_id, venue, side, requested_notional_micro,
       approved_notional_micro, expected_price, mode, state, capital_stage, created_at, updated_at)
     VALUES (?, ?, 'CRYPTO_SPOT://robinhood/WETH-USDG', 'evm:robinhood', 'buy',
       500000, 500000, 2500, 'canary', 'submitting', 1, 1, 1)`,
  ).run(intent, accountId);
  return Number(info.lastInsertRowid);
}

class FakeSigner implements TradingSigner {
  readonly kind = 'fake';
  signed = 0;
  async isReady() { return { ready: true, address: WALLET, detail: 'test' }; }
  async getAddress() { return WALLET; }
  async signTransaction(req: { nonce: number }) {
    this.signed++;
    return `0x${req.nonce.toString(16).padStart(2, '0')}${'ab'.repeat(16)}`;
  }
}

function fakeClient(db: DB, receipt: any = null) {
  let broadcasts = 0;
  return {
    get broadcasts() { return broadcasts; },
    async getTransactionCount() { return 7; },
    async estimateFeesPerGas() { return { maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }; },
    async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
      const durable = db.prepare(
        `SELECT state, signed_payload FROM execution_transactions WHERE signed_tx_hash=?`,
      ).get(keccak256(serializedTransaction)) as any;
      expect(durable.state).toBe('signed');
      expect(durable.signed_payload).toBe(serializedTransaction);
      broadcasts++;
      return keccak256(serializedTransaction);
    },
    async getTransactionReceipt() {
      if (receipt) return receipt;
      throw new Error('receipt not found');
    },
  };
}

describe('durable transaction coordination', () => {
  it('persists signed bytes before broadcast and makes duplicate submission harmless', async () => {
    const db = openTestDb();
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    const orderId = insertOrder(db, account.id);
    const signer = new FakeSigner();
    const client = fakeClient(db);
    const coordinator = new TransactionCoordinator(db, signer, client);
    const request = {
      orderId, accountId: account.id, purpose: 'swap' as const, idempotencyKey: 'signal:swap',
      chainId: 4663, walletAddress: WALLET, to: TARGET, data: '0x1234', value: 0n, gas: 100_000n,
    };

    const first = await coordinator.submit(request);
    const second = await coordinator.submit(request);
    expect(second).toEqual(first);
    expect(signer.signed).toBe(1);
    expect(client.broadcasts).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) n FROM execution_transactions`).get() as any).n).toBe(1);
    const order = db.prepare(`SELECT state, tx_ref FROM live_orders WHERE id=?`).get(orderId) as any;
    expect(order).toMatchObject({ state: 'pending', tx_ref: first.hash });
  });

  it('finishes an exact prepared transaction after restart', async () => {
    const db = openTestDb();
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    const orderId = insertOrder(db, account.id, 'prepared-order');
    db.prepare(
      `INSERT INTO execution_transactions
        (order_id, execution_account_id, purpose, idempotency_key, chain_id, wallet_address,
         nonce, to_address, data, value_wei, gas_limit, max_fee_per_gas,
         max_priority_fee_per_gas, state, created_at, updated_at)
       VALUES (?, ?, 'swap', 'prepared:swap', 4663, ?, 8, ?, '0x1234', '0', '100000',
         '20', '2', 'prepared', 1, 1)`,
    ).run(orderId, account.id, WALLET, TARGET);
    const signer = new FakeSigner();
    const client = fakeClient(db);

    const result = await new TransactionCoordinator(db, signer, client).recover();
    expect(result).toEqual({ recovered: 1, unresolved: 0 });
    expect(signer.signed).toBe(1);
    expect(client.broadcasts).toBe(1);
    expect((db.prepare(`SELECT state FROM execution_transactions`).get() as any).state).toBe('broadcast');
  });

  it('never signs or broadcasts a transaction backed by an expired firm quote', async () => {
    const db = openTestDb();
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    const orderId = insertOrder(db, account.id, 'expired-quote-order');
    const signer = new FakeSigner();
    const client = fakeClient(db);
    await expect(new TransactionCoordinator(db, signer, client).submit({
      orderId, accountId: account.id, purpose: 'swap', idempotencyKey: 'expired:swap',
      chainId: 4663, walletAddress: WALLET, to: TARGET, data: '0x1234', value: 0n,
      gas: 100_000n, expiresAt: Date.now() - 1,
    })).rejects.toThrow(/expired before signing/);
    expect(signer.signed).toBe(0);
    expect(client.broadcasts).toBe(0);
    expect(db.prepare(`SELECT state FROM execution_transactions`).get()).toMatchObject({ state: 'unknown' });
  });

  it('restores the order hash when a receipt exists but broadcast recording was interrupted', async () => {
    const db = openTestDb();
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    const orderId = insertOrder(db, account.id, 'receipt-order');
    const payload = '0x08' + 'cd'.repeat(16);
    const hash = keccak256(payload as Hex);
    db.prepare(
      `INSERT INTO execution_transactions
        (order_id, execution_account_id, purpose, idempotency_key, chain_id, wallet_address,
         nonce, to_address, data, value_wei, gas_limit, max_fee_per_gas,
         max_priority_fee_per_gas, signed_tx_hash, signed_payload, state, created_at, updated_at)
       VALUES (?, ?, 'swap', 'signed:swap', 4663, ?, 8, ?, '0x1234', '0', '100000',
         '20', '2', ?, ?, 'signed', 1, 1)`,
    ).run(orderId, account.id, WALLET, TARGET, hash, payload);
    const client = fakeClient(db, { status: 'success', blockNumber: 100n, blockHash: `0x${'ef'.repeat(32)}` });

    const result = await new TransactionCoordinator(db, new FakeSigner(), client).recover();
    expect(result).toEqual({ recovered: 1, unresolved: 0 });
    expect(db.prepare(`SELECT state FROM execution_transactions`).get()).toMatchObject({ state: 'confirmed' });
    expect(db.prepare(`SELECT state, tx_ref, venue_order_id FROM live_orders`).get()).toMatchObject({
      state: 'pending', tx_ref: hash, venue_order_id: hash,
    });
  });
});

describe('receipt settlement and clean-fill evidence', () => {
  it('posts exact receipt deltas once and only becomes clean after reconciliation', async () => {
    const db = openTestDb();
    const account = bindTraderWallet(db, WALLET);
    recordFunding(db, account.id, [
      { asset: 'USDG', qty: 5, txRef: '0xfund', logIndex: 0 },
      { asset: 'ETH', qty: 0.01, txRef: '0xfund', logIndex: -1 },
    ], 'test');
    const orderId = insertOrder(db, account.id, 'settled-order');
    const hash = `0x${'12'.repeat(32)}`;
    db.prepare(
      `INSERT INTO execution_transactions
        (order_id, execution_account_id, purpose, idempotency_key, chain_id, wallet_address,
         nonce, to_address, data, value_wei, gas_limit, max_fee_per_gas,
         max_priority_fee_per_gas, signed_tx_hash, state, confirmations, created_at, updated_at)
       VALUES (?, ?, 'swap', 'settled:swap', 4663, ?, 9, ?, '0x1234', '0', '100000',
         '20', '2', ?, 'confirmed', 12, 1, 1)`,
    ).run(orderId, account.id, WALLET, TARGET, hash);
    db.prepare(`UPDATE live_orders SET state='pending', tx_ref=?, venue_order_id=? WHERE id=?`)
      .run(hash, hash, orderId);
    const status = {
      state: 'filled' as const, filledQty: 0.0002, executedPrice: 2500, txRef: hash, confirmations: 12,
      assetDeltas: [
        { asset: 'USDG', qtyDelta: -0.5, logIndex: 1 },
        { asset: 'WETH', qtyDelta: 0.0002, logIndex: 2 },
        { asset: 'ETH', qtyDelta: -0.00001, logIndex: -1 },
      ],
    };

    expect(settleConfirmedOrder(db, orderId, status)).toBe(true);
    expect(settleConfirmedOrder(db, orderId, status)).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) n FROM live_ledger WHERE order_id=?`).get(orderId) as any).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) n FROM execution_asset_ledger WHERE order_id=?`).get(orderId) as any).n).toBe(3);
    expect(db.prepare(`SELECT state, clean_fill FROM live_orders WHERE id=?`).get(orderId))
      .toMatchObject({ state: 'filled', clean_fill: 0 });

    const holdings = custodyHoldings(db, account.id);
    const balances = [...holdings].map(([asset, qty]) => ({ asset, qty }));
    const adapter = {
      venue: 'evm:robinhood',
      async health() { return { venue: this.venue, status: 'online', latencyMs: 1, errorRate: 0, lastOkAt: 1, note: null }; },
      async getQuote() { return null; }, async placeOrder() { return { accepted: false }; },
      async reconcile() { return { ok: true, balances, positions: [], detail: 'chain state' }; },
    };
    const pass = await reconcileAccount(db, null, account.id, adapter as any);
    expect(pass.ok).toBe(true);
    expect(db.prepare(`SELECT clean_fill, reconciliation_run_id FROM live_orders WHERE id=?`).get(orderId))
      .toMatchObject({ clean_fill: 1 });
  });
});

describe('Manager capital allocation', () => {
  it('blocks autonomous real entries until the bot has a bounded USDG allocation', () => {
    const db = openTestDb();
    getLiveConfig(db);
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    const botId = Number(db.prepare(
      `INSERT INTO bots (name, kind, strategy_type, config_json, created_at)
       VALUES ('ALLOCATED BOT', 'house', 'momentum', '{}', 1)`,
    ).run().lastInsertRowid);
    recordFunding(db, account.id, [{ asset: 'USDG', qty: 5, txRef: '0xallocfund', logIndex: 0 }], 'test');
    db.prepare(
      `UPDATE live_config SET mode='canary', halted=0, capital_stage=1,
       execution_phase='autonomous_canary', autonomy_enabled=1 WHERE id=1`,
    ).run();
    const intent = {
      intentId: 'allocated-entry', botId, instrumentId: 'CRYPTO_SPOT://robinhood/WETH-USDG',
      venue: 'evm:robinhood', side: 'buy' as const, notionalUsd: 0.5, confidence: 99, reason: 'test',
    };
    const edge = {
      grossEdgeBps: 100, feeBps: 10, slippageBps: 10, bufferBps: 10, netEdgeBps: 70, edgeModel: 'test',
    };

    const blocked = evaluateIntent(db, intent, edge, account.id);
    expect(blocked.approved).toBe(false);
    expect(blocked.checks.find((check) => check.name === 'manager_allocation')?.pass).toBe(false);

    setBotAllocation(db, account.id, botId, 0.5, 'manager:test', 5);
    const approved = evaluateIntent(db, { ...intent, intentId: 'allocated-entry-2' }, edge, account.id);
    expect(approved.approved).toBe(true);
    expect(approved.checks.find((check) => check.name === 'manager_allocation')?.pass).toBe(true);
  });
});

describe('bounded exit routing', () => {
  it('records the full notional for a trusted receipt-derived lot close', () => {
    const db = openTestDb();
    getLiveConfig(db);
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    db.prepare(
      `UPDATE live_config SET mode='canary', halted=0, capital_stage=1,
       execution_phase='canary_probe', autonomy_enabled=0 WHERE id=1`,
    ).run();
    const intent = {
      intentId: 'exact-exit', botId: null,
      instrumentId: 'CRYPTO_SPOT://robinhood/WETH-USDG', venue: 'evm:robinhood',
      side: 'sell' as const, notionalUsd: 0.52, confidence: 1, reason: 'close exact receipt lot',
      forcedBy: 'operator:test',
    };
    const decision = evaluateIntent(db, intent, undefined, account.id, undefined, {
      isExit: true, exactFullExit: true,
    });
    expect(decision.checks.filter((check) => !check.pass)).toEqual([]);
    expect(decision.approved).toBe(true);
    expect(decision.sizeUsd).toBe(0.52);
    expect(decision.checks.find((check) => check.name === 'max_trade')?.detail)
      .toContain('full-lot exit');
  });

  it('routes the risk-approved slice instead of the full open lot', async () => {
    const db = openTestDb();
    getLiveConfig(db);
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    const botId = Number(db.prepare(
      `INSERT INTO bots (name, kind, strategy_type, config_json, created_at)
       VALUES ('EXIT BOT', 'house', 'momentum', '{}', 1)`,
    ).run().lastInsertRowid);
    recordFunding(db, account.id, [
      { asset: 'USDG', qty: 50, txRef: '0xexitfund', logIndex: 0 },
      { asset: 'WETH', qty: 0.02, txRef: '0xexitfund', logIndex: 1 },
    ], 'test');
    db.prepare(
      `INSERT INTO live_ledger
        (execution_account_id, bot_id, instrument_id, venue, side, qty, expected_price,
         executed_price, mode, ts)
       VALUES (?, ?, 'CRYPTO_SPOT://robinhood/WETH-USDG', 'evm:robinhood', 'buy',
         0.02, 2500, 2500, 'canary', 1)`,
    ).run(account.id, botId);
    db.prepare(`UPDATE live_config SET mode='canary', halted=0, capital_stage=4 WHERE id=1`).run();

    let routedNotional = 0;
    const adapter = {
      venue: 'evm:robinhood',
      async health() { return { venue: this.venue, status: 'online', latencyMs: 1, errorRate: 0, lastOkAt: 1, note: null }; },
      async getQuote() { return { instrumentId: '', price: 2500, ts: Date.now() }; },
      async placeOrder(_inst: unknown, _side: unknown, notional: number) {
        routedNotional = notional;
        return { accepted: true, pending: true, txRef: '0xpending', venueOrderId: '0xpending' };
      },
    };
    const network = new LiveNetwork(
      db, { publish() {} } as any, { history() { return []; } } as any,
      () => 2500, undefined, new Map([['evm:robinhood', adapter as any]]),
    );
    await (network as any).mirrorTrade({
      id: 1, botId, symbol: 'ETHUSDT', side: 'sell', qty: 0.02, price: 2500,
      feeUsd: 0, realizedPnlUsd: 0, ts: Date.now(), reason: 'operator exit test',
    }, 'operator:test', 'bounded-exit');

    expect(routedNotional).toBe(10);
  });
});

describe('mainnet pre-sign gates', () => {
  it('refuses a runtime RPC that is more than three blocks behind', async () => {
    const adapter = new ZeroXRobinhoodAdapter({
      apiKey: 'test', signer: new FakeSigner(),
      probeImpl: async () => [
        { label: 'primary', url: 'redacted', ok: true, blockNumber: 104, chainIdReported: 4663, latencyMs: 1, error: null },
        { label: 'public', url: 'redacted', ok: true, blockNumber: 104, chainIdReported: 4663, latencyMs: 1, error: null },
      ],
    });
    (adapter as any).client = {
      async getChainId() { return 4663; },
      async getBlockNumber() { return 100n; },
      async getBalance() { return 10_000_000_000_000_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 20_000_000n }; },
    };
    await expect((adapter as any).runtimeSafety(WALLET, 2500)).resolves.toMatch(/4 blocks behind/);
  });

  it('the signer policy decodes and bounds both USDG entries and WETH exits', () => {
    const policy = buildPolicy(50, 4663);
    const json = JSON.stringify(policy);
    expect(json).toContain('approve.spender');
    expect(json).toContain('exec.token');
    expect(json).toContain('exec.amount');
    expect(json).toContain(USDG_ADDRESS);
    expect(json).toContain(WETH_ADDRESS);
    expect(json).toContain(ZEROX_ALLOWANCE_HOLDER);
  });

  it('blocks low gas and an executable USDG price outside the 1% peg band', async () => {
    const db = openTestDb();
    const account = bindTraderWallet(db, WALLET);
    recordFunding(db, account.id, [
      { asset: 'USDG', qty: 5, txRef: '0xpreflight', logIndex: 0 },
      { asset: 'ETH', qty: 0.001, txRef: '0xpreflight', logIndex: -1 },
    ], 'test');
    db.prepare(
      `INSERT INTO reconciliation_runs (execution_account_id, started_at, completed_at, status, actor)
       VALUES (?, 1, 2, 'clean', 'test')`,
    ).run(account.id);
    const signer = {
      kind: 'test',
      async isReady() { return { ready: true, address: WALLET, detail: 'ready' }; },
      async getAddress() { return WALLET; },
      guards() { return { ownerEnforced: true, ownerId: 'owner', policyCount: 1, fullyGuarded: true }; },
      async signTransaction() { return '0x'; },
    };
    const adapter = {
      venue: 'evm:robinhood',
      async health() { return { venue: this.venue, status: 'online', latencyMs: 1, errorRate: 0, lastOkAt: 1, note: null }; },
      async getQuote() { return null; },
      async getExecutableQuote(inst: any) { return { instrumentId: inst.id, price: 2600, ts: Date.now() }; },
      async placeOrder() { return { accepted: false }; },
      async getBalances() { return [{ asset: 'USDG', qty: 5 }, { asset: 'ETH', qty: 0.001 }]; },
      async estimateGasReserveEth() { return 0.006; },
      async verifyCoreAssets() { return { ok: true, failures: [] }; },
      async reconcile() { return { ok: true, balances: [], positions: [], detail: 'test' }; },
    };
    const result = await runPreflight({
      db, signer: signer as any, adapters: new Map([['evm:robinhood', adapter as any]]),
      feedStatus: { test: { connected: true, stale: false } }, ethUsd: 2500,
    }, 'canary', 'test', { persist: false, targetStage: 1 });
    expect(result.checks.find((check) => check.name === 'gas_reserve')?.pass).toBe(false);
    expect(result.checks.find((check) => check.name === 'usdg_reference')?.pass).toBe(false);
  });
});
