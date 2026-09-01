import type { DB } from '../db/db.js';
import { toMicro } from '../money.js';
import type { AdapterOrderStatus } from './adapters.js';

/** Post a final receipt once. The receipt, not the order row, supplies amounts. */
export function settleConfirmedOrder(db: DB, orderId: number, status: AdapterOrderStatus): boolean {
  if (status.state !== 'filled' || !status.txRef || !status.assetDeltas?.length || !status.executedPrice) {
    throw new Error('receipt is not complete enough to settle');
  }
  if ((status.confirmations ?? 0) < 12) throw new Error('receipt has fewer than 12 confirmations');

  const order = db.prepare(`SELECT * FROM live_orders WHERE id = ?`).get(orderId) as any;
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.tx_ref && order.tx_ref.toLowerCase() !== status.txRef.toLowerCase()) {
    throw new Error(`receipt hash ${status.txRef} does not match order hash ${order.tx_ref}`);
  }
  const tx = db.prepare(
    `SELECT id FROM execution_transactions WHERE order_id = ? AND purpose = 'swap' AND signed_tx_hash = ?`,
  ).get(orderId, status.txRef) as { id: number } | undefined;
  if (!tx) throw new Error('no durable swap transaction matches the receipt');

  const existing = db.prepare(`SELECT id FROM live_ledger WHERE order_id = ?`).get(orderId);
  if (existing) return false;

  const expected = Number(order.expected_price ?? status.executedPrice);
  const slippageBps = expected > 0
    ? ((status.executedPrice - expected) / expected) * 10_000 * (order.side === 'buy' ? 1 : -1)
    : 0;
  const swapGasEth = -status.assetDeltas
    .filter((d) => d.asset === 'ETH' && d.qtyDelta < 0)
    .reduce((sum, d) => sum + d.qtyDelta, 0);
  const priorGas = db.prepare(
    `SELECT COALESCE(SUM(CAST(qty_delta AS REAL)),0) qty
     FROM execution_asset_ledger WHERE order_id=? AND asset='ETH' AND event_type='gas'`,
  ).get(orderId) as { qty: number };
  const gasEth = swapGasEth + Math.max(0, -priorGas.qty);
  const gasMicro = toMicro(gasEth * status.executedPrice);

  let realizedMicro = 0;
  if (order.side === 'sell') {
    const history = db.prepare(
      `SELECT side, qty, executed_price FROM live_ledger
       WHERE execution_account_id = ? AND bot_id IS ? AND instrument_id = ? ORDER BY id`,
    ).all(order.execution_account_id, order.bot_id, order.instrument_id) as
      { side: string; qty: number; executed_price: number }[];
    let held = 0;
    let cost = 0;
    for (const fill of history) {
      if (fill.side === 'buy') {
        cost += fill.qty * fill.executed_price;
        held += fill.qty;
      } else if (held > 0) {
        const sold = Math.min(held, fill.qty);
        const average = cost / held;
        held -= sold;
        cost -= sold * average;
      }
    }
    const sold = Math.min(held, status.filledQty);
    if (sold > 0 && held > 0) realizedMicro = toMicro(sold * (status.executedPrice - cost / held));
  }

  const now = Date.now();
  db.transaction(() => {
    const insertAsset = db.prepare(
      `INSERT OR IGNORE INTO execution_asset_ledger
        (execution_account_id, order_id, transaction_id, asset, qty_delta, event_type, tx_ref, log_index, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const delta of status.assetDeltas!) {
      insertAsset.run(order.execution_account_id, orderId, tx.id, delta.asset.toUpperCase(),
        String(delta.qtyDelta), delta.asset.toUpperCase() === 'ETH' ? 'gas' : 'fill',
        status.txRef, delta.logIndex, now);
    }
    db.prepare(
      `INSERT INTO live_ledger
        (order_id, execution_account_id, bot_id, instrument_id, venue, side, qty,
         expected_price, executed_price, fee_micro, gas_micro, slippage_bps,
         realized_pnl_micro, mode, tx_ref, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(orderId, order.execution_account_id, order.bot_id, order.instrument_id, order.venue,
      order.side, status.filledQty, expected, status.executedPrice, gasMicro, slippageBps,
      realizedMicro, order.mode, status.txRef, now);
    db.prepare(
      `UPDATE live_orders SET state='filled', filled_qty=?, executed_price=?, slippage_bps=?,
       gas_micro=?, confirmed_at=?, clean_fill=0, updated_at=? WHERE id=?`,
    ).run(status.filledQty, status.executedPrice, slippageBps, gasMicro, now, now, orderId);
  })();
  return true;
}
