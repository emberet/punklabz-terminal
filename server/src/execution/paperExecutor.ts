import { PAPER } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { toMicro } from '../money.js';
import type { Executor, Fill, OrderRequest } from './executor.js';

/**
 * Simulated matching. Market orders fill immediately at the last mark
 * ± slippage; limit orders persist in `orders` and fill when a mark crosses.
 * Fees: 10 bps of notional. Pump-token symbols (mint addresses, not *USDT)
 * get the harsher slippage model.
 */
export class PaperExecutor implements Executor {
  private fillCbs: ((fill: Fill) => void)[] = [];
  private marks = new Map<string, number>();

  constructor(private db: DB) {}

  onFill(cb: (fill: Fill) => void): void {
    this.fillCbs.push(cb);
  }

  getMark(symbol: string): number | undefined {
    return this.marks.get(symbol);
  }

  private slippage(symbol: string, side: 'buy' | 'sell', price: number): number {
    const isMajor = symbol.endsWith('USDT');
    const frac = isMajor ? PAPER.majorSlippageBps / 10_000 : PAPER.pumpSlippagePct / 100;
    return side === 'buy' ? price * (1 + frac) : price * (1 - frac);
  }

  async placeOrder(req: OrderRequest): Promise<{ orderId: number }> {
    const now = Date.now();
    if (req.type === 'market') {
      const mark = this.marks.get(req.symbol);
      if (mark === undefined) throw new Error(`no mark price for ${req.symbol}`);
      const fillPrice = this.slippage(req.symbol, req.side, mark);
      const info = this.db
        .prepare(
          `INSERT INTO orders (bot_id, symbol, side, type, qty, status, created_at, filled_at)
           VALUES (?, ?, ?, 'market', ?, 'filled', ?, ?)`,
        )
        .run(req.botId, req.symbol, req.side, req.qty, now, now);
      const orderId = Number(info.lastInsertRowid);
      this.emit({
        orderId,
        botId: req.botId,
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        price: fillPrice,
        feeMicro: toMicro((req.qty * fillPrice * PAPER.feeBps) / 10_000),
        ts: now,
      });
      return { orderId };
    }
    // limit: rest in the book
    if (req.limitPrice === undefined) throw new Error('limit order needs limitPrice');
    const info = this.db
      .prepare(
        `INSERT INTO orders (bot_id, symbol, side, type, qty, limit_price, status, created_at)
         VALUES (?, ?, ?, 'limit', ?, ?, 'open', ?)`,
      )
      .run(req.botId, req.symbol, req.side, req.qty, req.limitPrice, now);
    return { orderId: Number(info.lastInsertRowid) };
  }

  async cancelOrder(orderId: number): Promise<void> {
    this.db
      .prepare(`UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'open'`)
      .run(orderId);
  }

  /** New mark: check resting limits for crossings. */
  markPrice(symbol: string, price: number): void {
    this.marks.set(symbol, price);
    const open = this.db
      .prepare(
        `SELECT id, bot_id, side, qty, limit_price FROM orders
         WHERE status = 'open' AND symbol = ? AND type = 'limit'`,
      )
      .all(symbol) as { id: number; bot_id: number; side: 'buy' | 'sell'; qty: number; limit_price: number }[];
    const now = Date.now();
    for (const o of open) {
      const crosses = o.side === 'buy' ? price <= o.limit_price : price >= o.limit_price;
      if (!crosses) continue;
      this.db
        .prepare(`UPDATE orders SET status = 'filled', filled_at = ? WHERE id = ?`)
        .run(now, o.id);
      this.emit({
        orderId: o.id,
        botId: o.bot_id,
        symbol,
        side: o.side,
        qty: o.qty,
        price: o.limit_price, // limits fill at their price
        feeMicro: toMicro((o.qty * o.limit_price * PAPER.feeBps) / 10_000),
        ts: now,
      });
    }
  }

  private emit(fill: Fill) {
    for (const cb of this.fillCbs) cb(fill);
  }
}
