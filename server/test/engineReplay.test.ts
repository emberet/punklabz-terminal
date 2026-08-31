import { describe, expect, it } from 'vitest';
import type { Candle } from '@punklabz/shared';
import { openTestDb } from '../src/db/db.js';
import { CandleStore } from '../src/feeds/candles.js';
import { PaperExecutor } from '../src/execution/paperExecutor.js';
import { Engine } from '../src/engine/engine.js';
import { toMicro, fromMicro } from '../src/money.js';
import { computeEquity } from '../src/engine/accounting.js';
import { seedUser } from '../src/billing/ledger.js';

// End-to-end determinism: synthetic candles through the real store, engine,
// DSL strategy, and paper executor. A V-shaped tape must produce a dip buy and
// a recovery sell.

const DSL_CONFIG = {
  version: 1,
  name: 'replay dip buyer',
  market: { venue: 'binance', symbols: ['BTCUSDT'], interval: '1m' },
  capital: { initialBalanceUsd: 10000, positionSizePct: 10, maxOpenPositions: 1 },
  entry: { all: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'lt', value: 30 }] },
  exit: { any: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'gt', value: 55 }] },
  risk: { stopLossPct: 50, cooldownMinutes: 1, maxTradesPerDay: 10 },
};

function candle(i: number, close: number): Candle {
  const ts = 1_700_000_000_000 + i * 60_000;
  return { symbol: 'BTCUSDT', interval: '1m', ts, o: close + 0.5, h: close + 1, l: close - 1, c: close, v: 100 };
}

describe('engine replay', () => {
  it('V-shaped tape: dip buy, recovery sell, profit booked, ends flat', () => {
    const db = openTestDb();
    const userInfo = db
      .prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('r@x.com','r',1)`)
      .run();
    const userId = Number(userInfo.lastInsertRowid);
    seedUser(db, userId);
    const botInfo = db
      .prepare(`INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, status, created_at) VALUES (?, 'replay', 'quant', 'dsl', ?, 'running', 1)`)
      .run(userId, JSON.stringify(DSL_CONFIG));
    const botId = Number(botInfo.lastInsertRowid);
    db.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, 1)`)
      .run(botId, toMicro(10_000), toMicro(10_000));

    const candles = new CandleStore(db);
    const executor = new PaperExecutor(db);
    const engine = new Engine(db, candles, executor);
    engine.loadBots(); // no timers — candle-driven only

    // 20 down candles (RSI -> 0), then 20 up candles (RSI -> 100)
    let i = 0;
    for (let d = 0; d < 20; d++) candles.ingest1m(candle(i++, 1000 - d * 5));
    for (let u = 0; u < 20; u++) candles.ingest1m(candle(i++, 905 + u * 8));

    const trades = db.prepare(`SELECT side, price, realized_pnl_micro FROM trades WHERE bot_id = ? ORDER BY id`).all(botId) as any[];
    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');

    expect(buys.length).toBeGreaterThanOrEqual(1);
    expect(sells.length).toBeGreaterThanOrEqual(1);
    expect(sells[0].price).toBeGreaterThan(buys[0].price);
    expect(sells[0].realized_pnl_micro).toBeGreaterThan(0);

    // flat at the end, equity above nothing-burned floor
    const eq = computeEquity(db, botId, (s) => executor.getMark(s));
    const open = db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE bot_id = ? AND closed_at IS NULL`).get(botId) as { n: number };
    expect(open.n).toBe(0);
    expect(fromMicro(eq.equityMicro)).toBeGreaterThan(9_900);

    // the $1 quant trade tax was collected per trade
    const tax = db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE type = 'fee_trade_tax'`).get() as { n: number };
    expect(tax.n).toBe(trades.length);

    // rerun determinism: same tape on a fresh world produces the same trades
    const db2 = openTestDb();
    const u2 = db2.prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('r@x.com','r',1)`).run();
    seedUser(db2, Number(u2.lastInsertRowid));
    const b2 = db2
      .prepare(`INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, status, created_at) VALUES (?, 'replay', 'quant', 'dsl', ?, 'running', 1)`)
      .run(Number(u2.lastInsertRowid), JSON.stringify(DSL_CONFIG));
    db2.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, 1)`)
      .run(Number(b2.lastInsertRowid), toMicro(10_000), toMicro(10_000));
    const candles2 = new CandleStore(db2);
    const executor2 = new PaperExecutor(db2);
    const engine2 = new Engine(db2, candles2, executor2);
    engine2.loadBots();
    let j = 0;
    for (let d = 0; d < 20; d++) candles2.ingest1m(candle(j++, 1000 - d * 5));
    for (let u = 0; u < 20; u++) candles2.ingest1m(candle(j++, 905 + u * 8));
    const trades2 = db2.prepare(`SELECT side, price FROM trades ORDER BY id`).all() as any[];
    expect(trades2.map((t) => [t.side, t.price])).toEqual(trades.map((t) => [t.side, t.price]));
  });
});
