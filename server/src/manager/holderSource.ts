import type { DB } from '../db/db.js';
import type { HolderBalance } from './payoutMath.js';

/**
 * Where PunkLabz holder balances come from. Mock now; when the token launches,
 * SolanaHolderSource queries the chain (getProgramAccounts on the mint, or
 * Helius DAS getTokenAccounts) — swap is one config line in index.ts.
 */
export interface HolderSource {
  readonly name: 'mock' | 'solana';
  getSnapshot(): Promise<HolderBalance[]>;
}

const SEED_HOLDERS: HolderBalance[] = [
  { address: 'PunkWhale111111111111111111111111111111111', balance: 48_000_000 },
  { address: 'PunkWhale222222222222222222222222222222222', balance: 25_500_000 },
  { address: 'PunkChad3333333333333333333333333333333333', balance: 12_000_000 },
  { address: 'PunkChad4444444444444444444444444444444444', balance: 8_700_000 },
  { address: 'PunkHolder55555555555555555555555555555555', balance: 5_200_000 },
  { address: 'PunkHolder66666666666666666666666666666666', balance: 3_900_000 },
  { address: 'PunkHolder77777777777777777777777777777777', balance: 2_400_000 },
  { address: 'PunkHolder88888888888888888888888888888888', balance: 1_850_000 },
  { address: 'PunkHolder99999999999999999999999999999999', balance: 1_300_000 },
  { address: 'PunkHolderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', balance: 1_000_000 },
  // below threshold — excluded from payouts
  { address: 'PunkShrimpBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', balance: 940_000 },
  { address: 'PunkShrimpCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', balance: 610_000 },
  { address: 'PunkShrimpDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', balance: 220_000 },
  { address: 'PunkShrimpEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', balance: 87_000 },
  { address: 'PunkShrimpFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', balance: 12_000 },
];

export class MockHolderSource implements HolderSource {
  readonly name = 'mock' as const;
  async getSnapshot(): Promise<HolderBalance[]> {
    return SEED_HOLDERS.map((h) => ({ ...h }));
  }
}

export class SolanaHolderSource implements HolderSource {
  readonly name = 'solana' as const;
  constructor(private mintAddress: string) {}
  async getSnapshot(): Promise<HolderBalance[]> {
    throw new Error(
      `SolanaHolderSource NOT_IMPLEMENTED for mint ${this.mintAddress} — ` +
        'implement with getProgramAccounts or Helius DAS once PunkLabz launches',
    );
  }
}

/** Persist a snapshot; returns its id. */
export function saveSnapshot(db: DB, source: HolderSource['name'], holders: HolderBalance[]): number {
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO holder_snapshots (ts, source) VALUES (?, ?)')
      .run(Date.now(), source);
    const snapshotId = Number(info.lastInsertRowid);
    const stmt = db.prepare('INSERT INTO holders (snapshot_id, address, balance) VALUES (?, ?, ?)');
    for (const h of holders) stmt.run(snapshotId, h.address, h.balance);
    return snapshotId;
  });
  return tx();
}
