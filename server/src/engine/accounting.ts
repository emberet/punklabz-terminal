import type { DB } from '../db/db.js';
import { toMicro } from '../money.js';
import type { Fill } from '../execution/executor.js';
import { chargeTradeTax } from '../billing/ledger.js';

export interface OpenPosition {
  id: number;
  symbol: string;
  qty: number;
  avgEntry: number;
  openedAt: number;
}

export interface ApplyFillResult {
  tradeId: number;
  realizedPnlMicro: number;
  /** false when a quant owner couldn't pay the $1 tax — engine should pause the bot */
  taxPaid: boolean;
}

export function getOpenPosition(db: DB, botId: number, symbol: string): OpenPosition | null {
  const row = db
    .prepare(
      `SELECT id, symbol, qty, avg_entry AS avgEntry, opened_at AS openedAt
       FROM positions WHERE bot_id = ? AND symbol = ? AND closed_at IS NULL`,
    )
    .get(botId, symbol) as OpenPosition | undefined;
  return row ?? null;
}

export function getOpenPositions(db: DB, botId: number): OpenPosition[] {
  return db
    .prepare(
      `SELECT id, symbol, qty, avg_entry AS avgEntry, opened_at AS openedAt
       FROM positions WHERE bot_id = ? AND closed_at IS NULL`,
    )
    .all(botId) as OpenPosition[];
}

export function getCashMicro(db: DB, botId: number): number {
  const row = db.prepare('SELECT cash_micro FROM bot_accounts WHERE bot_id = ?').get(botId) as
    | { cash_micro: number }
    | undefined;
  if (!row) throw new Error(`no account for bot ${botId}`);
  return row.cash_micro;
}

/**
 * Book a fill: trade row + position update + cash move + (quant) trade tax,
 * all in ONE transaction. Average-cost accounting; realized PnL on reduces.
 * Long-only (buys open/add, sells reduce/close) — matches every strategy here.
 */
export function applyFill(
  db: DB,
  fill: Fill,
  opts: { quantOwnerUserId?: number } = {},
): ApplyFillResult {
  const tx = db.transaction((): ApplyFillResult => {
    const pos = getOpenPosition(db, fill.botId, fill.symbol);
    const notionalMicro = toMicro(fill.qty * fill.price);
    let realizedPnlMicro = 0;

    if (fill.side === 'buy') {
      if (pos) {
        const newQty = pos.qty + fill.qty;
        const newAvg = (pos.avgEntry * pos.qty + fill.price * fill.qty) / newQty;
        db.prepare('UPDATE positions SET qty = ?, avg_entry = ? WHERE id = ?').run(
          newQty,
          newAvg,
          pos.id,
        );
      } else {
        db.prepare(
          `INSERT INTO positions (bot_id, symbol, qty, avg_entry, opened_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(fill.botId, fill.symbol, fill.qty, fill.price, fill.ts);
      }
      db.prepare('UPDATE bot_accounts SET cash_micro = cash_micro - ?, updated_at = ? WHERE bot_id = ?').run(
        notionalMicro + fill.feeMicro,
        fill.ts,
        fill.botId,
      );
    } else {
      if (!pos) throw new Error(`sell with no open position: bot ${fill.botId} ${fill.symbol}`);
      const sellQty = Math.min(fill.qty, pos.qty);
      realizedPnlMicro = toMicro(sellQty * (fill.price - pos.avgEntry)) - fill.feeMicro;
      const remaining = pos.qty - sellQty;
      if (remaining <= 1e-9) {
        db.prepare('UPDATE positions SET qty = 0, closed_at = ? WHERE id = ?').run(fill.ts, pos.id);
      } else {
        db.prepare('UPDATE positions SET qty = ? WHERE id = ?').run(remaining, pos.id);
      }
      db.prepare('UPDATE bot_accounts SET cash_micro = cash_micro + ?, updated_at = ? WHERE bot_id = ?').run(
        toMicro(sellQty * fill.price) - fill.feeMicro,
        fill.ts,
        fill.botId,
      );
    }

    const info = db
      .prepare(
        `INSERT INTO trades (bot_id, order_id, symbol, side, qty, price, fee_micro, realized_pnl_micro, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fill.botId,
        fill.orderId,
        fill.symbol,
        fill.side,
        fill.qty,
        fill.price,
        fill.feeMicro,
        realizedPnlMicro,
        fill.ts,
      );
    const tradeId = Number(info.lastInsertRowid);

    let taxPaid = true;
    if (opts.quantOwnerUserId !== undefined) {
      taxPaid = chargeTradeTax(db, opts.quantOwnerUserId, fill.botId, tradeId);
    }
    return { tradeId, realizedPnlMicro, taxPaid };
  });
  return tx();
}

export interface EquitySnapshot {
  equityMicro: number;
  realizedPnlMicro: number;
  unrealizedPnlMicro: number;
  tradeCount: number;
  winCount: number;
}

export function computeEquity(
  db: DB,
  botId: number,
  markOf: (symbol: string) => number | undefined,
): EquitySnapshot {
  const cash = getCashMicro(db, botId);
  const positions = getOpenPositions(db, botId);
  let posValueMicro = 0;
  let unrealizedMicro = 0;
  for (const p of positions) {
    const mark = markOf(p.symbol) ?? p.avgEntry;
    posValueMicro += toMicro(p.qty * mark);
    unrealizedMicro += toMicro(p.qty * (mark - p.avgEntry));
  }
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_micro), 0) AS realized,
              COUNT(*) AS n,
              SUM(CASE WHEN side = 'sell' AND realized_pnl_micro > 0 THEN 1 ELSE 0 END) AS wins
       FROM trades WHERE bot_id = ?`,
    )
    .get(botId) as { realized: number; n: number; wins: number };
  return {
    equityMicro: cash + posValueMicro,
    realizedPnlMicro: agg.realized,
    unrealizedPnlMicro: unrealizedMicro,
    tradeCount: agg.n,
    winCount: agg.wins ?? 0,
  };
}

export function snapshotMetrics(
  db: DB,
  botId: number,
  markOf: (symbol: string) => number | undefined,
): void {
  const s = computeEquity(db, botId, markOf);
  db.prepare(
    `INSERT OR REPLACE INTO bot_metrics (bot_id, ts, equity_micro, realized_pnl_micro, unrealized_pnl_micro, trade_count, win_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    botId,
    Math.floor(Date.now() / 60_000) * 60_000,
    s.equityMicro,
    s.realizedPnlMicro,
    s.unrealizedPnlMicro,
    s.tradeCount,
    s.winCount,
  );
}
