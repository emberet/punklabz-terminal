import type { ExecutionMode } from '@punklabz/shared';
import type { DB } from '../db/db.js';

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
}

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
  };
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
  const name =
    mode === 'shadow' ? 'SHADOW_BOOK'
      : mode === 'simulation' ? 'SIMULATION_BOOK'
      : `${mode.toUpperCase()}_${venue.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const existing = db.prepare(`SELECT * FROM execution_accounts WHERE name = ?`).get(name);
  if (existing) return row(existing);
  const info = db
    .prepare(
      `INSERT INTO execution_accounts (name, mode, venue, currency, funded_usd, active, created_at)
       VALUES (?, ?, ?, 'USDC', 0, 1, ?)`,
    )
    .run(name, mode, venue, Date.now());
  return getAccount(db, Number(info.lastInsertRowid))!;
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
