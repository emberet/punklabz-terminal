import { describe, expect, it } from 'vitest';
import type { Candle, StrategyConfig } from '@punklabz/shared';
import { openTestDb } from '../src/db/db.js';
import { CandleStore } from '../src/feeds/candles.js';
import { PaperExecutor } from '../src/execution/paperExecutor.js';
import { Engine } from '../src/engine/engine.js';
import { runBacktest, BacktestError, resolveWindow } from '../src/backtest/backtester.js';
import { toMicro } from '../src/money.js';
import { seedUser } from '../src/billing/ledger.js';

const DSL_CONFIG: StrategyConfig = {
  version: 1,
  name: 'bt dip buyer',
  market: { venue: 'binance', symbols: ['BTCUSDT'], interval: '1m' },
  capital: { initialBalanceUsd: 10000, positionSizePct: 10, maxOpenPositions: 1 },
  entry: { all: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'lt', value: 30 }] },
  exit: { any: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'gt', value: 55 }] },
  risk: { stopLossPct: 50, cooldownMinutes: 1, maxTradesPerDay: 10 },
} as StrategyConfig;

const T0 = 1_700_000_000_000;

function candle(i: number, close: number): Candle {
  return {
    symbol: 'BTCUSDT', interval: '1m', ts: T0 + i * 60_000,
    o: close + 0.5, h: close + 1, l: close - 1, c: close, v: 100,
  };
}

function vTape(): Candle[] {
  const out: Candle[] = [];
  let i = 0;
  for (let d = 0; d < 20; d++) out.push(candle(i++, 1000 - d * 5));
  for (let u = 0; u < 20; u++) out.push(candle(i++, 905 + u * 8));
  return out;
}

describe('backtester', () => {
  it('V-shaped tape: dip buy, recovery sell, profit, flat end, reasons captured', async () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    store.insertMany(vTape());

    const res = await runBacktest(store, DSL_CONFIG, { fromTs: T0, toTs: T0 + 40 * 60_000 });
    const buys = res.trades.filter((t) => t.side === 'buy');
    const sells = res.trades.filter((t) => t.side === 'sell');
    expect(buys.length).toBeGreaterThanOrEqual(1);
    expect(sells.length).toBeGreaterThanOrEqual(1);
    expect(sells[0].price).toBeGreaterThan(buys[0].price);
    expect(sells[0].realizedPnlUsd).toBeGreaterThan(0);
    expect(res.pnlUsd).toBeGreaterThan(0);
    expect(res.trades.every((t) => t.reason.length > 0)).toBe(true);
    expect(res.equityCurve.length).toBeLessThanOrEqual(201);
    expect(res.estimatedTradeTaxUsd).toBe(res.tradeCount);
  });

  it('never writes to the database', async () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    store.insertMany(vTape());
    await runBacktest(store, DSL_CONFIG, { fromTs: T0, toTs: T0 + 40 * 60_000 });
    for (const t of ['trades', 'orders', 'positions', 'bot_accounts']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
  });

  it('is deterministic', async () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    store.insertMany(vTape());
    const a = await runBacktest(store, DSL_CONFIG, { fromTs: T0, toTs: T0 + 40 * 60_000 });
    const b = await runBacktest(store, DSL_CONFIG, { fromTs: T0, toTs: T0 + 40 * 60_000 });
    expect(a).toEqual(b);
  });

  it('golden parity: matches the live engine on [side, qty, price]', async () => {
    // live run through the real Engine + PaperExecutor
    const db = openTestDb();
    const u = db.prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('p@x.com','p',1)`).run();
    seedUser(db, Number(u.lastInsertRowid));
    const b = db
      .prepare(`INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, status, created_at) VALUES (?, 'p', 'quant', 'dsl', ?, 'running', 1)`)
      .run(Number(u.lastInsertRowid), JSON.stringify(DSL_CONFIG));
    db.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, 1)`)
      .run(Number(b.lastInsertRowid), toMicro(10_000), toMicro(10_000));
    const liveStore = new CandleStore(db);
    const executor = new PaperExecutor(db);
    const engine = new Engine(db, liveStore, executor);
    engine.loadBots();
    for (const c of vTape()) liveStore.ingest1m(c);
    const liveTrades = db.prepare(`SELECT side, qty, price FROM trades ORDER BY id`).all() as any[];

    // backtest on the same tape in a fresh world
    const db2 = openTestDb();
    const store2 = new CandleStore(db2);
    store2.insertMany(vTape());
    const bt = await runBacktest(store2, DSL_CONFIG, { fromTs: T0, toTs: T0 + 40 * 60_000 });

    expect(bt.trades.map((t) => [t.side, Number(t.qty.toFixed(9)), Number(t.price.toFixed(6))])).toEqual(
      liveTrades.map((t) => [t.side, Number(t.qty.toFixed(9)), Number(t.price.toFixed(6))]),
    );
  });

  it('rejects 30d/90d for non-1h intervals and thin history', async () => {
    expect(() => resolveWindow(DSL_CONFIG, '30d')).toThrow(BacktestError);
    expect(() => resolveWindow({ ...DSL_CONFIG, market: { ...DSL_CONFIG.market, interval: '1h' } }, '90d')).not.toThrow();

    const db = openTestDb();
    const store = new CandleStore(db);
    store.insertMany(vTape().slice(0, 10));
    await expect(runBacktest(store, DSL_CONFIG, { fromTs: T0, toTs: T0 + 10 * 60_000 })).rejects.toThrow(/not enough/);
  });
});
