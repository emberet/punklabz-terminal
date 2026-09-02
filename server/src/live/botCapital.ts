import type { LiveBotCapitalView } from '@punklabz/shared';
import type { DB } from '../db/db.js';

const MICRO = 1_000_000;
const TRADER_ACCOUNT = 'ROBINHOOD_TRADER_01';

/**
 * Attribute the shared Trader wallet's real ledger to one house bot.
 * The Manager allocation is that bot's opening USDG cash. Receipt-derived
 * token deltas then move value between cash and exposure; paper books never
 * enter this calculation.
 */
export function liveBotCapital(
  db: DB,
  botId: number,
  markOf: (symbol: string) => number | undefined,
): LiveBotCapitalView | null {
  const account = db.prepare(
    `SELECT id, mode, chain_id, settlement_asset
     FROM execution_accounts WHERE name=? AND active=1`,
  ).get(TRADER_ACCOUNT) as {
    id: number; mode: 'canary' | 'live'; chain_id: number; settlement_asset: string;
  } | undefined;
  if (!account || account.chain_id !== 4663 || account.settlement_asset !== 'USDG') return null;

  const allocation = db.prepare(
    `SELECT allocated_usdg, active FROM manager_capital_allocations
     WHERE execution_account_id=? AND bot_id=?`,
  ).get(account.id, botId) as { allocated_usdg: number; active: number } | undefined;
  const allocatedUsd = allocation?.active === 1 ? allocation.allocated_usdg : 0;

  const rows = db.prepare(
    `SELECT l.asset, l.qty_delta
     FROM execution_asset_ledger l
     JOIN live_orders o ON o.id=l.order_id
     WHERE l.execution_account_id=? AND o.bot_id=? AND l.event_type IN ('fill','fee')
     ORDER BY l.id`,
  ).all(account.id, botId) as { asset: string; qty_delta: string }[];
  const holdings: Record<string, number> = {};
  for (const row of rows) {
    const asset = row.asset.toUpperCase();
    holdings[asset] = (holdings[asset] ?? 0) + Number(row.qty_delta);
  }

  const cashUsd = allocatedUsd + (holdings.USDG ?? 0);
  const wethMark = markOf('ETHUSDT') ?? 0;
  const exposureUsd = Math.max(0, holdings.WETH ?? 0) * wethMark;
  const ledger = db.prepare(
    `SELECT COALESCE(SUM(realized_pnl_micro-fee_micro-gas_micro),0) net,
            COUNT(*) fills
     FROM live_ledger
     WHERE execution_account_id=? AND bot_id=?`,
  ).get(account.id, botId) as { net: number; fills: number };
  const pending = db.prepare(
    `SELECT COUNT(*) n FROM live_orders
     WHERE execution_account_id=? AND bot_id=?
       AND state IN ('risk_approved','submitting','submitted','pending','open','partial','reconciling')`,
  ).get(account.id, botId) as { n: number };
  const reconciliation = db.prepare(
    `SELECT status, completed_at FROM reconciliation_runs
     WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`,
  ).get(account.id) as { status: string; completed_at: number | null } | undefined;
  const config = db.prepare(
    `SELECT autonomy_enabled, halted FROM live_config WHERE id=1`,
  ).get() as { autonomy_enabled: number; halted: number } | undefined;

  return {
    mode: account.mode,
    chainId: account.chain_id,
    settlementAsset: 'USDG',
    allocatedUsd,
    cashUsd,
    exposureUsd,
    navUsd: cashUsd + exposureUsd,
    netPnlUsd: ledger.net / MICRO,
    fillCount: ledger.fills,
    pendingCount: pending.n,
    holdings,
    reconciliationStatus: reconciliation?.status ?? null,
    reconciledAt: reconciliation?.completed_at ?? null,
    autonomyEnabled: config?.autonomy_enabled === 1,
    halted: config?.halted !== 0,
  };
}
