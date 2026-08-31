import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { applyFill, computeEquity, getOpenPosition } from '../src/engine/accounting.js';
import { PaperExecutor } from '../src/execution/paperExecutor.js';
import { toMicro } from '../src/money.js';
import { seedUser } from '../src/billing/ledger.js';

function mkOrder(db: DB, botId: number, side: 'buy' | 'sell'): number {
  const info = db
    .prepare(`INSERT INTO orders (bot_id, symbol, side, type, qty, status, created_at) VALUES (?, 'X', ?, 'market', 1, 'filled', 1)`)
    .run(botId, side);
  return Number(info.lastInsertRowid);
}

function mkBot(db: DB, kind = 'house', ownerId: number | null = null): number {
  const info = db
    .prepare(`INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, created_at) VALUES (?, 'b', ?, 'x', '{}', ?)`)
    .run(ownerId, kind, Date.now());
  const id = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, toMicro(10_000), toMicro(10_000), Date.now());
  return id;
}

describe('accounting', () => {
  let db: DB;
  let bot: number;

  beforeEach(() => {
    db = openTestDb();
    bot = mkBot(db);
  });

  it('buy then profitable sell books realized pnl net of fees', () => {
    applyFill(db, { orderId: mkOrder(db, bot, "buy"), botId: bot, symbol: "BTCUSDT", side: "buy", qty: 0.1, price: 50_000, feeMicro: toMicro(5), ts: 1 });
    const pos = getOpenPosition(db, bot, 'BTCUSDT')!;
    expect(pos.qty).toBeCloseTo(0.1);
    expect(pos.avgEntry).toBe(50_000);

    const r = applyFill(db, { orderId: mkOrder(db, bot, "sell"), botId: bot, symbol: "BTCUSDT", side: "sell", qty: 0.1, price: 55_000, feeMicro: toMicro(5.5), ts: 2 });
    // 0.1 * 5000 = 500 profit − 5.50 sell fee
    expect(r.realizedPnlMicro).toBe(toMicro(500 - 5.5));
    expect(getOpenPosition(db, bot, 'BTCUSDT')).toBeNull();
  });

  it('averages entry price across adds', () => {
    applyFill(db, { orderId: mkOrder(db, bot, "buy"), botId: bot, symbol: "ETHUSDT", side: "buy", qty: 1, price: 2000, feeMicro: 0, ts: 1 });
    applyFill(db, { orderId: mkOrder(db, bot, "buy"), botId: bot, symbol: "ETHUSDT", side: "buy", qty: 1, price: 3000, feeMicro: 0, ts: 2 });
    expect(getOpenPosition(db, bot, 'ETHUSDT')!.avgEntry).toBe(2500);
  });

  it('equity = cash + marked positions; round trip conserves value minus fees', () => {
    const start = computeEquity(db, bot, () => undefined).equityMicro;
    applyFill(db, { orderId: mkOrder(db, bot, "buy"), botId: bot, symbol: "SOLUSDT", side: "buy", qty: 10, price: 100, feeMicro: toMicro(1), ts: 1 });
    applyFill(db, { orderId: mkOrder(db, bot, "sell"), botId: bot, symbol: "SOLUSDT", side: "sell", qty: 10, price: 100, feeMicro: toMicro(1), ts: 2 });
    const end = computeEquity(db, bot, () => undefined).equityMicro;
    expect(start - end).toBe(toMicro(2)); // exactly the fees
  });

  it('quant fills charge the $1 tax exactly once inside the fill transaction', () => {
    const info = db.prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('q@x.com','q',1)`).run();
    const userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    const qbot = mkBot(db, 'quant', userId);
    const r = applyFill(
      db,
      { orderId: mkOrder(db, qbot, 'buy'), botId: qbot, symbol: 'BTCUSDT', side: 'buy', qty: 0.01, price: 50_000, feeMicro: 0, ts: 1 },
      { quantOwnerUserId: userId },
    );
    expect(r.taxPaid).toBe(true);
    const tax = db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE type='fee_trade_tax'`).get() as { n: number };
    expect(tax.n).toBe(1);
  });
});

describe('paper executor', () => {
  let db: DB;
  let bot: number;

  beforeEach(() => {
    db = openTestDb();
    bot = mkBot(db);
  });

  it('market orders fill at mark with slippage against the taker', async () => {
    const ex = new PaperExecutor(db);
    const fills: any[] = [];
    ex.onFill((f) => fills.push(f));
    ex.markPrice('BTCUSDT', 50_000);
    await ex.placeOrder({ botId: bot, symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.1 });
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBeGreaterThan(50_000); // 5bps up on buys
    expect(fills[0].price).toBeCloseTo(50_000 * 1.0005, 6);
  });

  it('limit orders rest and fill when price crosses', async () => {
    const ex = new PaperExecutor(db);
    const fills: any[] = [];
    ex.onFill((f) => fills.push(f));
    ex.markPrice('BTCUSDT', 50_000);
    await ex.placeOrder({ botId: bot, symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, limitPrice: 49_000 });
    expect(fills).toHaveLength(0);
    ex.markPrice('BTCUSDT', 49_500);
    expect(fills).toHaveLength(0);
    ex.markPrice('BTCUSDT', 48_900);
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBe(49_000); // fills at its limit
  });

  it('canceled limits never fill', async () => {
    const ex = new PaperExecutor(db);
    const fills: any[] = [];
    ex.onFill((f) => fills.push(f));
    ex.markPrice('BTCUSDT', 50_000);
    const { orderId } = await ex.placeOrder({ botId: bot, symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, limitPrice: 49_000 });
    await ex.cancelOrder(orderId);
    ex.markPrice('BTCUSDT', 40_000);
    expect(fills).toHaveLength(0);
  });
});
