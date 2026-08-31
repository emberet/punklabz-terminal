import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  balanceMicro, chargeCreation, chargeReuse, chargeTradeTax,
  InsufficientFunds, ledgerZeroSum, postEntry, seedUser,
} from '../src/billing/ledger.js';
import { toMicro } from '../src/money.js';

function mkUser(db: DB, email: string): number {
  const info = db
    .prepare(`INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)`)
    .run(email, email, Date.now());
  return Number(info.lastInsertRowid);
}

function mkBot(db: DB, ownerId: number): number {
  const info = db
    .prepare(`INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, created_at) VALUES (?, 'b', 'quant', 'dsl', '{}', ?)`)
    .run(ownerId, Date.now());
  return Number(info.lastInsertRowid);
}

function mkTrade(db: DB, botId: number): number {
  const info = db
    .prepare(`INSERT INTO trades (bot_id, symbol, side, qty, price, ts) VALUES (?, 'BTCUSDT', 'buy', 1, 100, ?)`)
    .run(botId, Date.now());
  return Number(info.lastInsertRowid);
}

describe('ledger', () => {
  let db: DB;
  let alice: number;
  let bob: number;

  beforeEach(() => {
    db = openTestDb();
    alice = mkUser(db, 'alice@x.com');
    bob = mkUser(db, 'bob@x.com');
    seedUser(db, alice);
    seedUser(db, bob);
  });

  it('seeds $100 on signup', () => {
    expect(balanceMicro(db, `user:${alice}`)).toBe(toMicro(100));
  });

  it('creation fee moves $20 user -> platform and rejects overdrafts', () => {
    const bot = mkBot(db, alice);
    chargeCreation(db, alice, bot);
    expect(balanceMicro(db, `user:${alice}`)).toBe(toMicro(80));
    expect(balanceMicro(db, 'platform')).toBe(toMicro(20));
    // drain and retry
    postEntry(db, 'fee_creation', toMicro(80), `user:${alice}`, 'platform', { memo: 'drain' });
    expect(() => chargeCreation(db, alice, bot)).toThrow(InsufficientFunds);
  });

  it('reuse fee sends 100% to the original creator', () => {
    const bot = mkBot(db, alice);
    chargeReuse(db, bob, alice, bot);
    expect(balanceMicro(db, `user:${bob}`)).toBe(toMicro(90));
    expect(balanceMicro(db, `user:${alice}`)).toBe(toMicro(110));
    expect(balanceMicro(db, 'platform')).toBe(0);
  });

  it('trade tax is 1% of notional, idempotent on trade id, and soft-fails when broke', () => {
    const bot = mkBot(db, alice);
    const trade = mkTrade(db, bot);
    // $500 notional -> $5.00 tax
    expect(chargeTradeTax(db, alice, bot, trade, 500)).toBe(true);
    expect(chargeTradeTax(db, alice, bot, trade, 500)).toBe(true); // no double charge
    expect(balanceMicro(db, `user:${alice}`)).toBe(toMicro(95));
    expect(balanceMicro(db, 'platform')).toBe(toMicro(5));

    // dust trades still pay the floor
    const dust = mkTrade(db, bot);
    chargeTradeTax(db, alice, bot, dust, 0.10);
    expect(balanceMicro(db, 'platform')).toBe(toMicro(5.01));

    postEntry(db, 'fee_creation', toMicro(94.99), `user:${alice}`, 'platform', { memo: 'drain' });
    const trade2 = mkTrade(db, bot);
    expect(chargeTradeTax(db, alice, bot, trade2, 500)).toBe(false);
  });

  it('zero-sum invariant holds through arbitrary activity', () => {
    const bot = mkBot(db, alice);
    chargeCreation(db, alice, bot);
    chargeReuse(db, bob, alice, bot);
    for (let i = 0; i < 5; i++) chargeTradeTax(db, alice, bot, mkTrade(db, bot), 20);
    expect(ledgerZeroSum(db)).toBe(true);
  });
});
