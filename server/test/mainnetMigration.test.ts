import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'src/db/migrations');
const safetySql = fs.readFileSync(path.join(migrationsDir, '016_mainnet_safety.sql'), 'utf8');

function beforeSafetyMigration() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && f < '016_').sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  return db;
}

function insertAccount(db: Database.Database, name: string, mode: string, venue: string): number {
  return Number(db.prepare(
    `INSERT INTO execution_accounts (name, mode, venue, currency, funded_usd, active, created_at)
     VALUES (?, ?, ?, 'USDC', 0, 1, 1)`,
  ).run(name, mode, venue).lastInsertRowid);
}

function insertOrder(db: Database.Database, accountId: number, intent: string, state: string) {
  db.prepare(
    `INSERT INTO live_orders
      (intent_id, execution_account_id, instrument_id, venue, side, requested_notional_micro,
       mode, state, created_at, updated_at)
     VALUES (?, ?, 'x', 'evm:robinhood', 'buy', 500000, 'canary', ?, 1, 1)`,
  ).run(intent, accountId, state);
}

describe('Robinhood custody migration', () => {
  it('moves only real Robinhood custody and leaves shadow credits in the shadow account', () => {
    const db = beforeSafetyMigration();
    const shadow = insertAccount(db, 'CANARY_SHADOW_OLD', 'canary', 'shadow');
    const real = insertAccount(db, 'CANARY_EVM_ROBINHOOD_OLD', 'canary', 'evm:robinhood');
    const fund = db.prepare(
      `INSERT INTO execution_account_funding
        (execution_account_id, asset, qty, tx_ref, actor, note, audit_hash, ts)
       VALUES (?, 'USDG', ?, ?, 'test', 'migration fixture', 'hash', 1)`,
    );
    fund.run(shadow, 50, '0xshadow');
    fund.run(real, 5, '0xreal');
    insertOrder(db, shadow, 'shadow-fill', 'filled');
    insertOrder(db, real, 'real-fill', 'filled');

    db.transaction(() => db.exec(safetySql))();

    const trader = db.prepare(`SELECT id, currency, chain_id, settlement_asset FROM execution_accounts WHERE name='ROBINHOOD_TRADER_01'`)
      .get() as any;
    expect(trader).toMatchObject({ currency: 'USDG', chain_id: 4663, settlement_asset: 'USDG' });
    expect(db.prepare(`SELECT execution_account_id FROM execution_account_funding WHERE tx_ref='0xreal'`).get())
      .toMatchObject({ execution_account_id: trader.id });
    expect(db.prepare(`SELECT execution_account_id FROM execution_account_funding WHERE tx_ref='0xshadow'`).get())
      .toMatchObject({ execution_account_id: shadow });
    expect(db.prepare(`SELECT execution_account_id FROM live_orders WHERE intent_id='shadow-fill'`).get())
      .toMatchObject({ execution_account_id: shadow });
    expect(db.prepare(`SELECT execution_account_id FROM live_orders WHERE intent_id='real-fill'`).get())
      .toMatchObject({ execution_account_id: trader.id });
    expect((db.prepare(
      `SELECT COALESCE(SUM(CAST(qty_delta AS REAL)),0) qty FROM execution_asset_ledger
       WHERE execution_account_id=? AND asset='USDG'`,
    ).get(trader.id) as any).qty).toBe(5);
    db.close();
  });

  it('aborts atomically when a real Robinhood order is unresolved', () => {
    const db = beforeSafetyMigration();
    const real = insertAccount(db, 'CANARY_EVM_ROBINHOOD_OLD', 'canary', 'evm:robinhood');
    insertOrder(db, real, 'pending-real', 'pending');

    expect(() => db.transaction(() => db.exec(safetySql))()).toThrow(/unresolved Robinhood orders/);
    const columns = db.prepare(`PRAGMA table_info(execution_accounts)`).all() as { name: string }[];
    expect(columns.some((column) => column.name === 'chain_id')).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) n FROM execution_accounts WHERE name='ROBINHOOD_TRADER_01'`).get())
      .toMatchObject({ n: 0 });
    db.close();
  });
});
