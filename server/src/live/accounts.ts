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

// ── external funding ─────────────────────────────────────────────────────────

export interface FundingEntry {
  asset: string;
  qty: number;
  txRef?: string | null;
  note?: string | null;
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
  const hash = appendAudit(db, actor, 'account_funding', { accountId, entries });
  const stmt = db.prepare(
    `INSERT INTO execution_account_funding
       (execution_account_id, asset, qty, tx_ref, actor, note, audit_hash, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction(() => {
    let n = 0;
    for (const e of entries) {
      if (!Number.isFinite(e.qty) || e.qty === 0) continue;
      stmt.run(accountId, e.asset, e.qty, e.txRef ?? null, actor, e.note ?? null, hash, ts);
      n++;
    }
    return n;
  })();
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
