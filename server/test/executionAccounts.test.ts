import { describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { accountBook, accountForMode, listAccounts } from '../src/live/accounts.js';
import { ExecutionRouter } from '../src/live/executionRouter.js';
import { buildAdapters, NotConfiguredAdapter } from '../src/live/adapters.js';
import { runPreflight } from '../src/live/preflight.js';
import { NoSigner } from '../src/live/signing/signer.js';
import { recoverPendingOrders } from '../src/live/reconciler.js';
import { getLiveConfig, setCapitalStage, setLiveMode } from '../src/live/riskEngine.js';
import { toMicro } from '../src/money.js';

function bookTrade(db: DB, accountId: number, pnlUsd: number, ts = Date.now()) {
  db.prepare(
    `INSERT INTO live_ledger (execution_account_id, instrument_id, venue, side, qty,
       expected_price, executed_price, realized_pnl_micro, mode, ts)
     VALUES (?, 'CRYPTO_SPOT://binance/BTCUSDT', 'shadow', 'sell', 1, 100, 100, ?, 'shadow', ?)`,
  ).run(accountId, toMicro(pnlUsd), ts);
}

describe('execution account partitioning', () => {
  it('shadow profit never contributes to a live account NAV', () => {
    const db = openTestDb();
    const shadow = accountForMode(db, 'shadow');
    const live = accountForMode(db, 'live', 'evm:base');
    expect(shadow.id).not.toBe(live.id);

    // shadow books a big theoretical win
    bookTrade(db, shadow.id, 30);

    // the live account, funded with $100, must still read exactly $100
    const liveBook = accountBook(db, live.id, 100);
    expect(liveBook.navUsd).toBe(100);
    expect(liveBook.realizedPnlUsd).toBe(0);

    // and the shadow account sees its own gain, nobody else's
    const shadowBook = accountBook(db, shadow.id, 0);
    expect(shadowBook.realizedPnlUsd).toBe(30);
  });

  it('drawdown is computed per account, not across the whole ledger', () => {
    const db = openTestDb();
    const shadow = accountForMode(db, 'shadow');
    const live = accountForMode(db, 'live', 'evm:base');

    bookTrade(db, shadow.id, -50, Date.now() - 20_000); // shadow blows up
    bookTrade(db, live.id, -2, Date.now() - 10_000);    // live loses a little

    const liveBook = accountBook(db, live.id, 100);
    // 2% drawdown, not 52%
    expect(liveBook.drawdownPct).toBeCloseTo(2, 1);
    expect(liveBook.navUsd).toBe(98);
  });

  it('accounts are created once and reused', () => {
    const db = openTestDb();
    const a = accountForMode(db, 'canary', 'evm:base');
    const b = accountForMode(db, 'canary', 'evm:base');
    expect(a.id).toBe(b.id);
    expect(listAccounts(db).filter((x) => x.name === a.name)).toHaveLength(1);
  });
});

describe('execution router', () => {
  const markOf = () => 50_000;

  it('shadow mode may fall back to the shadow adapter', () => {
    const router = new ExecutionRouter(buildAdapters(markOf));
    const d = router.route({
      instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
      side: 'buy', notionalUsd: 5, maxSlippageBps: 35, mode: 'shadow',
    });
    expect(d.routable).toBe(true);
    expect(d.venue).toBe('shadow');
  });

  it('live mode NEVER falls back to shadow — it refuses instead', () => {
    const adapters = buildAdapters(markOf);
    const d = new ExecutionRouter(adapters).route({
      instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT', // venue: paper
      side: 'buy', notionalUsd: 5, maxSlippageBps: 35, mode: 'live',
    });
    expect(d.routable).toBe(false);
    expect(d.reason).toMatch(/simulated venue|ADAPTER_UNAVAILABLE/);
  });

  it('live mode refuses a venue with no configured adapter', () => {
    const adapters = buildAdapters(markOf);
    adapters.delete('evm:base');
    const d = new ExecutionRouter(adapters).route({
      instrumentId: 'CRYPTO_SPOT://base/ETH-USDC',
      side: 'buy', notionalUsd: 5, maxSlippageBps: 35, mode: 'canary',
    });
    expect(d.routable).toBe(false);
    expect(d.reason).toMatch(/adapter not configured|ADAPTER_UNAVAILABLE|not tradable/);
  });

  it('an unconfigured adapter refuses orders rather than pretending', async () => {
    const adapter = new NotConfiguredAdapter('evm:base', 'no signer');
    const result = await adapter.placeOrder();
    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/NOT_CONFIGURED/);
  });
});

describe('live preflight', () => {
  const deps = (db: DB) => ({
    db,
    signer: new NoSigner(),
    adapters: buildAdapters(() => 50_000),
    feedStatus: { binance: { connected: true, stale: false } },
  });

  it('shadow passes with healthy feeds and a clean book', async () => {
    const db = openTestDb();
    const r = await runPreflight(deps(db), 'shadow');
    expect(r.passed).toBe(true);
  });

  it('live fails closed, naming every missing prerequisite', async () => {
    const db = openTestDb();
    const r = await runPreflight(deps(db), 'live');
    expect(r.passed).toBe(false);
    const failed = r.checks.filter((c) => c.blocking && !c.pass).map((c) => c.name);
    expect(failed).toContain('signer');
    expect(failed).toContain('execution_adapter');
    expect(failed).toContain('funded_balance');
    // and the reasons are readable, not a bare refusal
    expect(r.blockers.join(' ')).toMatch(/no signing service configured/);

    // instrument_mapping used to be listed here as a proxy for "LIVE_MAPPINGS
    // is empty". It is no longer empty — ETHUSDT resolves to WETH/USDG on
    // Robinhood Chain — so that check now legitimately PASSES, and asserting
    // otherwise would be asserting the absence of the feature this work adds.
    // The gate is unweakened: live is still closed on the four above.
    expect(r.checks.find((c) => c.name === 'instrument_mapping')?.pass).toBe(true);
  });

  it('unresolved orders block any venue mode', async () => {
    const db = openTestDb();
    const acct = accountForMode(db, 'shadow');
    db.prepare(
      `INSERT INTO live_orders (intent_id, execution_account_id, instrument_id, venue, side,
         requested_notional_micro, mode, state, created_at, updated_at)
       VALUES ('stuck', ?, 'x', 'evm:base', 'buy', 1000000, 'canary', 'pending', 1, 1)`,
    ).run(acct.id);
    const r = await runPreflight(deps(db), 'canary');
    expect(r.checks.find((c) => c.name === 'no_unresolved_orders')?.pass).toBe(false);
  });

  it('every run is recorded for audit', async () => {
    const db = openTestDb();
    await runPreflight(deps(db), 'live', 'tester');
    const runs = db.prepare(`SELECT * FROM preflight_runs`).all() as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBe(0);
    expect(runs[0].actor).toBe('tester');
  });
});

describe('mode + stage gating', () => {
  it('canary/live need a passing preflight, not an assertion', () => {
    const db = openTestDb();
    expect(() => setLiveMode(db, 'live', 'test')).toThrow(/preflight result is required/);
    expect(() => setLiveMode(db, 'live', 'test', { passed: false, blockers: ['signer: none'] }))
      .toThrow(/preflight failed/);
    // shadow needs no preflight at all
    setLiveMode(db, 'shadow', 'test');
    expect(getLiveConfig(db).mode).toBe('shadow');
  });

  it('stage promotion requires evidence; demotion is always allowed', () => {
    const db = openTestDb();
    setCapitalStage(db, 1, 'test'); // first real-capital step needs no fills
    expect(getLiveConfig(db).capitalStage).toBe(1);

    // stage 2 wants 20 clean fills — we have none
    expect(() => setCapitalStage(db, 2, 'test')).toThrow(/clean fill/);

    // stepping back down is never blocked
    setCapitalStage(db, 0, 'test');
    expect(getLiveConfig(db).capitalStage).toBe(0);
  });
});

describe('boot recovery', () => {
  it('parks orders it cannot resolve and halts the network', async () => {
    const db = openTestDb();
    const acct = accountForMode(db, 'canary', 'evm:base');
    db.prepare(
      `INSERT INTO live_orders (intent_id, execution_account_id, instrument_id, venue, side,
         requested_notional_micro, mode, state, created_at, updated_at)
       VALUES ('inflight', ?, 'x', 'evm:base', 'buy', 5000000, 'canary', 'submitting', 1, 1)`,
    ).run(acct.id);

    const result = await recoverPendingOrders(db, null, buildAdapters(() => 1));
    expect(result.unresolved).toBe(1);

    const order = db.prepare(`SELECT state, reject_reason FROM live_orders WHERE intent_id='inflight'`).get() as any;
    expect(order.state).toBe('reconciling');
    expect(order.reject_reason).toMatch(/unresolvable/);

    // an unknown in-flight order is a reason to stop, not to guess
    expect(getLiveConfig(db).halted).toBe(true);
    expect(getLiveConfig(db).haltReason).toMatch(/unresolved/);
  });

  it('a duplicate intent id cannot create a second order', () => {
    const db = openTestDb();
    const acct = accountForMode(db, 'shadow');
    const insert = () =>
      db.prepare(
        `INSERT INTO live_orders (intent_id, execution_account_id, instrument_id, venue, side,
           requested_notional_micro, mode, state, created_at, updated_at)
         VALUES ('plz_dup', ?, 'x', 'shadow', 'buy', 1000000, 'shadow', 'proposed', 1, 1)`,
      ).run(acct.id);
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });
});
