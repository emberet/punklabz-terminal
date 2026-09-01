import type { DB } from '../db/db.js';
import { parseUnits } from 'viem';

export interface RawAssetEntry {
  executionAccountId: number;
  orderId?: number;
  transactionId?: number;
  chainId: number;
  symbol: string;
  contractAddress: string;
  decimals: number;
  rawDelta: bigint;
  eventType: 'funding' | 'fill' | 'gas' | 'fee' | 'adjustment';
  txRef: string;
  logIndex: number;
  snapshotHash: string;
  ts?: number;
}

export function insertRawAssetEntry(db: DB, entry: RawAssetEntry): void {
  if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 36) throw new Error('invalid token decimals');
  if (!/^0x[0-9a-f]{40}$/i.test(entry.contractAddress)) throw new Error('raw ledger entry needs an exact contract');
  if (!/^0x[0-9a-f]{64}$/i.test(entry.txRef)) throw new Error('raw ledger entry needs a transaction hash');
  db.prepare(
    `INSERT OR IGNORE INTO execution_asset_ledger
       (execution_account_id, order_id, transaction_id, asset, qty_delta, event_type,
        tx_ref, log_index, ts, chain_id, contract_address, decimals, raw_delta, snapshot_hash)
     VALUES (?, ?, ?, ?, '0', ?, ?, ?, ?, ?, lower(?), ?, ?, ?)`,
  ).run(
    entry.executionAccountId, entry.orderId ?? null, entry.transactionId ?? null,
    entry.symbol.toUpperCase(), entry.eventType, entry.txRef.toLowerCase(), entry.logIndex,
    entry.ts ?? Date.now(), entry.chainId, entry.contractAddress, entry.decimals,
    entry.rawDelta.toString(), entry.snapshotHash,
  );
}

/** Exact holdings for the generalized path. No SQLite REAL conversion. */
export function rawHoldings(db: DB, accountId: number): Map<string, bigint> {
  const rows = db.prepare(
    `SELECT contract_address, raw_delta FROM execution_asset_ledger
     WHERE execution_account_id=? AND raw_delta IS NOT NULL ORDER BY id`,
  ).all(accountId) as { contract_address: string; raw_delta: string }[];
  const result = new Map<string, bigint>();
  for (const row of rows) {
    const contract = row.contract_address.toLowerCase();
    result.set(contract, (result.get(contract) ?? 0n) + BigInt(row.raw_delta));
  }
  return result;
}

function expandScientific(value: string): string {
  if (!/[eE]/.test(value)) return value;
  const [coefficient, expText] = value.toLowerCase().split('e');
  const exponent = Number(expText);
  if (!Number.isInteger(exponent)) throw new Error(`invalid decimal ${value}`);
  const negative = coefficient.startsWith('-');
  const unsigned = coefficient.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? '-' : ''}${expanded}`;
}

/** One-time compatibility bridge: converts attested legacy decimal entries, never chain balances. */
export function backfillLegacyRawLedger(db: DB): number {
  const rows = db.prepare(
    `SELECT id, asset, qty_delta FROM execution_asset_ledger WHERE raw_delta IS NULL ORDER BY id`,
  ).all() as { id: number; asset: string; qty_delta: string }[];
  let updated = 0;
  const set = db.prepare(
    `UPDATE execution_asset_ledger SET chain_id=4663, contract_address=?, decimals=?, raw_delta=? WHERE id=? AND raw_delta IS NULL`,
  );
  for (const row of rows) {
    const symbol = row.asset.toUpperCase();
    const token = symbol === 'ETH'
      ? { contract: '0x0000000000000000000000000000000000000000', decimals: 18 }
      : db.prepare(
        `SELECT contract_address contract, decimals FROM rh_assets
         WHERE chain_id=4663 AND symbol=? AND verified_onchain=1`,
      ).get(symbol) as { contract: string; decimals: number } | undefined;
    if (!token) continue;
    try {
      const raw = parseUnits(expandScientific(String(row.qty_delta)), token.decimals);
      set.run(token.contract.toLowerCase(), token.decimals, raw.toString(), row.id);
      updated++;
    } catch {
      // Unparseable legacy entries remain visibly incomplete and block raw reconciliation.
    }
  }
  return updated;
}
