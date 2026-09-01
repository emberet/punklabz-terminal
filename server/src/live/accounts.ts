import type { ExecutionMode } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { appendAudit } from '../audit/auditLog.js';

// Execution accounts keep books apart. Shadow profit is not live NAV, canary
// is not live, and a broker account is not a wallet. Every order and every
// ledger row names exactly one account.

export interface ExecutionAccount {
  id: number;
  name: string;
  mode: ExecutionMode;
  venue: string;
  walletAddress: string | null;
  currency: string;
  fundedUsd: number;
  active: boolean;
  chainId: number | null;
  settlementAsset: string | null;
  role: 'book' | 'manager_operating' | 'trader';
}

export const ROBINHOOD_TRADER_ACCOUNT = 'ROBINHOOD_TRADER_01';
export const MANAGER_OPERATING_ACCOUNT = 'MANAGER_OPERATING_01';

function row(r: any): ExecutionAccount {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    venue: r.venue,
    walletAddress: r.wallet_address,
    currency: r.currency,
    fundedUsd: r.funded_usd,
    active: r.active === 1,
    chainId: r.chain_id ?? null,
    settlementAsset: r.settlement_asset ?? null,
    role: r.role ?? (r.venue === 'evm:robinhood' ? 'trader' : 'book'),
  };
}

/**
 * Reclassify the funded wallet as Manager custody and bind a fresh Trader.
 * Nothing moves between books here: historical funding stays attached to the
 * wallet that actually received it. The later confirmed custody transfers are
 * the only events that can capitalize the new Trader account.
 */
export function separateManagerAndTrader(
  db: DB,
  traderWalletAddress: string,
  actor: string,
): { manager: ExecutionAccount; trader: ExecutionAccount } {
  const next = traderWalletAddress.toLowerCase();
  const existingManager = db.prepare(`SELECT * FROM execution_accounts WHERE name=?`)
    .get(MANAGER_OPERATING_ACCOUNT) as any;
  const existingTrader = db.prepare(`SELECT * FROM execution_accounts WHERE name=?`)
    .get(ROBINHOOD_TRADER_ACCOUNT) as any;

  if (existingManager && existingTrader) {
    const manager = row(existingManager);
    const trader = row(existingTrader);
    if (trader.walletAddress?.toLowerCase() !== next) {
      throw new Error(`trader account is already bound to ${trader.walletAddress}`);
    }
    return { manager, trader };
  }
  if (!existingTrader?.wallet_address) throw new Error('funded Trader account has no wallet to reclassify');
  if (existingTrader.wallet_address.toLowerCase() === next) {
    throw new Error('Manager and Trader wallets must be different addresses');
  }

  const unresolvedOrders = (db.prepare(
    `SELECT COUNT(*) n FROM live_orders
     WHERE execution_account_id=? AND state IN ('submitting','submitted','pending','open','partial','reconciling')`,
  ).get(existingTrader.id) as { n: number }).n;
  const unresolvedTx = (db.prepare(
    `SELECT COUNT(*) n FROM execution_transactions
     WHERE execution_account_id=? AND state IN ('prepared','signed','broadcast','unknown')`,
  ).get(existingTrader.id) as { n: number }).n;
  if (unresolvedOrders + unresolvedTx > 0) {
    throw new Error('unresolved real orders or transactions block wallet separation');
  }

  return db.transaction(() => {
    const now = Date.now();
    db.prepare(
      `UPDATE execution_accounts SET name=?, role='manager_operating', active=1 WHERE id=?`,
    ).run(MANAGER_OPERATING_ACCOUNT, existingTrader.id);
    db.prepare(
      `INSERT INTO execution_accounts
        (name, mode, venue, wallet_address, currency, funded_usd, active, created_at,
         chain_id, settlement_asset, role)
       VALUES (?, 'canary', 'evm:robinhood', ?, 'USDG', 0, 1, ?, 4663, 'USDG', 'trader')`,
    ).run(ROBINHOOD_TRADER_ACCOUNT, next, now);
    db.prepare(
      `UPDATE live_config SET mode='shadow', halted=1, halt_reason=?, capital_stage=0,
       execution_phase='shadow', autonomy_enabled=0, updated_at=? WHERE id=1`,
    ).run('separate Trader wallet created; confirmed funding and reconciliation required', now);
    appendAudit(db, actor, 'custody_wallet_separated', {
      managerAccountId: existingTrader.id,
      traderWalletAddress: next,
    });
    return {
      manager: getAccount(db, existingTrader.id)!,
      trader: row(db.prepare(`SELECT * FROM execution_accounts WHERE name=?`)
        .get(ROBINHOOD_TRADER_ACCOUNT)),
    };
  })();
}

export function listAccounts(db: DB): ExecutionAccount[] {
  return (db.prepare(`SELECT * FROM execution_accounts ORDER BY id`).all() as any[]).map(row);
}

export function getAccount(db: DB, id: number): ExecutionAccount | null {
  const r = db.prepare(`SELECT * FROM execution_accounts WHERE id = ?`).get(id);
  return r ? row(r) : null;
}

/** the account a given execution mode books to; created on demand */
export function accountForMode(db: DB, mode: ExecutionMode, venue = 'shadow'): ExecutionAccount {
  const realMoney = mode === 'canary' || mode === 'live';
  const name = realMoney
    ? ROBINHOOD_TRADER_ACCOUNT
    : mode === 'shadow' ? 'SHADOW_BOOK' : 'SIMULATION_BOOK';
  const existing = db.prepare(`SELECT * FROM execution_accounts WHERE name = ?`).get(name);
  if (existing) return row(existing);
  const info = db
    .prepare(
      `INSERT INTO execution_accounts
         (name, mode, venue, currency, funded_usd, active, created_at, chain_id, settlement_asset)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    )
    .run(name, realMoney ? 'canary' : mode, realMoney ? 'evm:robinhood' : venue,
      realMoney ? 'USDG' : 'USDC', Date.now(), realMoney ? 4663 : null, realMoney ? 'USDG' : null);
  return getAccount(db, Number(info.lastInsertRowid))!;
}

/** Bind the one physical execution wallet. A different address is a refusal. */
export function bindTraderWallet(db: DB, walletAddress: string): ExecutionAccount {
  const account = accountForMode(db, 'canary', 'evm:robinhood');
  if (account.walletAddress && account.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`trader account is bound to ${account.walletAddress}, signer reports ${walletAddress}`);
  }
  db.prepare(`UPDATE execution_accounts SET wallet_address = ? WHERE id = ?`)
    .run(walletAddress.toLowerCase(), account.id);
  return getAccount(db, account.id)!;
}

export function assertTraderWallet(db: DB, walletAddress: string): ExecutionAccount {
  const account = db.prepare(`SELECT * FROM execution_accounts WHERE name = ?`)
    .get(ROBINHOOD_TRADER_ACCOUNT);
  if (!account) throw new Error('trader execution account is missing');
  const parsed = row(account);
  if (!parsed.walletAddress) throw new Error('trader execution account is not bound to a wallet');
  if (parsed.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`trader account is bound to ${parsed.walletAddress}, signer reports ${walletAddress}`);
  }
  return parsed;
}

export interface AccountBook {
  realizedPnlUsd: number;
  feesUsd: number;
  deployedUsd: number;
  openOrders: number;
  navUsd: number;
  peakNavUsd: number;
  drawdownPct: number;
  todayPnlUsd: number;
}

/**
 * All P&L math for ONE account. Never sums across accounts — that was the
 * latent bug: shadow gains inflating a live wallet's apparent NAV.
 */
export function accountBook(db: DB, accountId: number, baseCapitalUsd: number): AccountBook {
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const micro = 1_000_000;

  const all = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_micro),0) p, COALESCE(SUM(fee_micro + gas_micro),0) f
       FROM live_ledger WHERE execution_account_id = ?`,
    )
    .get(accountId) as { p: number; f: number };
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_micro - fee_micro - gas_micro),0) s
       FROM live_ledger WHERE execution_account_id = ? AND ts >= ?`,
    )
    .get(accountId, dayStart) as { s: number };
  const deployed = db
    .prepare(
      `SELECT COALESCE(SUM(approved_notional_micro),0) s, COUNT(*) n
       FROM live_orders
       WHERE execution_account_id = ?
         AND state IN ('risk_approved','submitting','submitted','pending','open','partial')`,
    )
    .get(accountId) as { s: number; n: number };

  const series = db
    .prepare(
      `SELECT realized_pnl_micro - fee_micro - gas_micro AS d
       FROM live_ledger WHERE execution_account_id = ? ORDER BY ts ASC`,
    )
    .all(accountId) as { d: number }[];
  let cum = baseCapitalUsd;
  let peak = baseCapitalUsd;
  let dd = 0;
  for (const s of series) {
    cum += s.d / micro;
    peak = Math.max(peak, cum);
    if (peak > 0) dd = Math.max(dd, ((peak - cum) / peak) * 100);
  }

  return {
    realizedPnlUsd: all.p / micro,
    feesUsd: all.f / micro,
    deployedUsd: deployed.s / micro,
    openOrders: deployed.n,
    navUsd: baseCapitalUsd + (all.p - all.f) / micro,
    peakNavUsd: peak,
    drawdownPct: dd,
    todayPnlUsd: today.s / micro,
  };
}

// ── external funding ─────────────────────────────────────────────────────────

export interface FundingEntry {
  asset: string;
  qty: number;
  txRef?: string | null;
  note?: string | null;
  logIndex?: number | null;
  contractAddress?: string | null;
  decimals?: number | null;
  rawQty?: string | null;
  snapshotHash?: string | null;
}

/**
 * Record money entering (or leaving) an execution account from outside trading.
 *
 * The caller states the amount. This deliberately does NOT read the chain and
 * write down whatever it finds — that would make reconciliation compare the
 * chain against itself and always pass, which is exactly the "fix the database
 * to match the chain" failure the reconciler forbids. An operator attests; the
 * reconciler then checks that attestation against the chain and still halts if
 * they disagree.
 */
export function recordFunding(
  db: DB,
  accountId: number,
  entries: FundingEntry[],
  actor: string,
): number {
  const ts = Date.now();
  const account = getAccount(db, accountId);
  if (!account) throw new Error(`execution account ${accountId} not found`);
  if (account.venue === 'evm:robinhood') {
    for (const entry of entries) {
      if (!entry.txRef || !Number.isInteger(entry.logIndex)) {
        throw new Error('real funding must include its decoded transaction hash and log index');
      }
    }
  }
  const stmt = db.prepare(
    `INSERT INTO execution_account_funding
       (execution_account_id, asset, qty, tx_ref, actor, note, audit_hash, ts, log_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const assetStmt = db.prepare(
    `INSERT INTO execution_asset_ledger
       (execution_account_id, asset, qty_delta, event_type, tx_ref, log_index, ts,
        chain_id, contract_address, decimals, raw_delta, snapshot_hash)
     VALUES (?, ?, ?, 'funding', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction(() => {
    const hash = appendAudit(db, actor, 'account_funding', { accountId, entries });
    let n = 0;
    for (const e of entries) {
      if (!Number.isFinite(e.qty) || e.qty === 0) continue;
      const asset = e.asset.toUpperCase();
      stmt.run(accountId, asset, e.qty, e.txRef ?? null, actor, e.note ?? null, hash, ts, e.logIndex ?? null);
      assetStmt.run(accountId, asset, String(e.qty), e.txRef ?? null, e.logIndex ?? null, ts,
        e.contractAddress ? 4663 : null, e.contractAddress?.toLowerCase() ?? null,
        e.decimals ?? null, e.rawQty ?? null, e.snapshotHash ?? null);
      n++;
    }
    return n;
  })();
}

export interface CustodyTransferEntry {
  fromAccountId: number;
  toAccountId: number;
  asset: 'USDG' | 'ETH';
  qty: number;
  txRef: string;
  logIndex: number;
  gasEth?: number;
  confirmations: number;
}

/** Record both sides of a confirmed Manager -> Trader transfer exactly once. */
export function recordCustodyTransfer(db: DB, entry: CustodyTransferEntry, actor: string): number {
  if (!(entry.qty > 0) || !Number.isFinite(entry.qty)) throw new Error('custody transfer quantity must be positive');
  if (entry.fromAccountId === entry.toAccountId) throw new Error('custody transfer accounts must be different');
  if (entry.confirmations < 12) throw new Error('custody transfer requires 12 confirmations');
  if (!/^0x[0-9a-fA-F]{64}$/.test(entry.txRef)) throw new Error('custody transfer needs a transaction hash');
  const from = getAccount(db, entry.fromAccountId);
  const to = getAccount(db, entry.toAccountId);
  if (from?.role !== 'manager_operating' || to?.role !== 'trader') {
    throw new Error('custody transfer must move from Manager Operating to Trader');
  }
  const existing = db.prepare(
    `SELECT id, from_account_id, to_account_id, qty, confirmations FROM custody_transfers
     WHERE lower(tx_ref)=lower(?) AND asset=? AND log_index=?`,
  ).get(entry.txRef, entry.asset, entry.logIndex) as
    { id: number; from_account_id: number; to_account_id: number; qty: string; confirmations: number } | undefined;
  if (existing) {
    if (existing.from_account_id !== entry.fromAccountId || existing.to_account_id !== entry.toAccountId
      || Number(existing.qty) !== entry.qty || existing.confirmations < 12) {
      throw new Error('existing custody transfer reference does not match this ceremony');
    }
    return existing.id;
  }

  return db.transaction(() => {
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO custody_transfers
        (from_account_id, to_account_id, asset, qty, tx_ref, log_index, gas_eth,
         confirmations, actor, confirmed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(entry.fromAccountId, entry.toAccountId, entry.asset, String(entry.qty),
      entry.txRef.toLowerCase(), entry.logIndex, String(entry.gasEth ?? 0),
      entry.confirmations, actor, now, now);
    recordFunding(db, entry.fromAccountId, [{
      asset: entry.asset, qty: -entry.qty, txRef: entry.txRef.toLowerCase(),
      logIndex: entry.logIndex, note: `confirmed transfer to ${to.name}`,
    }], actor);
    recordFunding(db, entry.toAccountId, [{
      asset: entry.asset, qty: entry.qty, txRef: entry.txRef.toLowerCase(),
      logIndex: entry.logIndex, note: `confirmed transfer from ${from.name}`,
    }], actor);
    if ((entry.gasEth ?? 0) > 0) {
      db.prepare(
        `INSERT INTO execution_asset_ledger
          (execution_account_id, asset, qty_delta, event_type, tx_ref, log_index, ts)
         VALUES (?, 'ETH', ?, 'gas', ?, -2, ?)`,
      ).run(entry.fromAccountId, String(-entry.gasEth!), entry.txRef.toLowerCase(), now);
    }
    appendAudit(db, actor, 'custody_transfer_confirmed', {
      transferId: Number(info.lastInsertRowid), fromAccountId: entry.fromAccountId,
      toAccountId: entry.toAccountId, asset: entry.asset, qty: entry.qty,
      txRef: entry.txRef.toLowerCase(), confirmations: entry.confirmations,
    });
    return Number(info.lastInsertRowid);
  })();
}

/** Exact asset quantities the immutable custody ledger says the wallet holds. */
export function custodyHoldings(db: DB, accountId: number): Map<string, number> {
  const out = new Map<string, number>();
  const rows = db.prepare(
    `SELECT asset, qty_delta FROM execution_asset_ledger
     WHERE execution_account_id = ? ORDER BY id`,
  ).all(accountId) as { asset: string; qty_delta: string }[];
  for (const entry of rows) {
    out.set(entry.asset.toUpperCase(), (out.get(entry.asset.toUpperCase()) ?? 0) + Number(entry.qty_delta));
  }
  return out;
}

export function allocatedUsdg(db: DB, accountId: number): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(allocated_usdg), 0) n FROM manager_capital_allocations
     WHERE execution_account_id = ? AND active = 1`,
  ).get(accountId) as { n: number };
  return r.n;
}

export function setBotAllocation(
  db: DB,
  accountId: number,
  botId: number,
  allocated: number,
  actor: string,
  authorizedCapital: number,
): void {
  if (!Number.isFinite(allocated) || allocated < 0) throw new Error('allocation must be a non-negative USDG amount');
  const other = db.prepare(
    `SELECT COALESCE(SUM(allocated_usdg),0) n FROM manager_capital_allocations
     WHERE execution_account_id = ? AND bot_id <> ? AND active = 1`,
  ).get(accountId, botId) as { n: number };
  if (other.n + allocated > authorizedCapital + 1e-9) {
    throw new Error(`allocation would exceed authorized capital ${authorizedCapital} USDG`);
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO manager_capital_allocations
       (execution_account_id, bot_id, allocated_usdg, active, actor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_account_id, bot_id) DO UPDATE SET
       allocated_usdg = excluded.allocated_usdg, active = excluded.active, actor = excluded.actor,
       updated_at = excluded.updated_at`,
  ).run(accountId, botId, allocated, allocated > 0 ? 1 : 0, actor, now, now);
  appendAudit(db, actor, 'manager_capital_allocation', { accountId, botId, allocatedUsdg: allocated });
}

/** What has been attested as funded for this account, per asset. */
export function fundingFor(db: DB, accountId: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db
    .prepare(`SELECT asset, SUM(qty) q FROM execution_account_funding WHERE execution_account_id = ? GROUP BY asset`)
    .all(accountId) as { asset: string; q: number }[]) {
    out.set(r.asset, r.q);
  }
  return out;
}
