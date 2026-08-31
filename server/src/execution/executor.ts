import type { OrderType, Side } from '@punklabz/shared';

export interface OrderRequest {
  botId: number;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number;
}

export interface Fill {
  orderId: number;
  botId: number;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  feeMicro: number;
  ts: number;
}

/**
 * The paper/live boundary. PaperExecutor simulates fills; a future LiveExecutor
 * talks to a real venue behind this same interface — the engine never knows which.
 */
export interface Executor {
  placeOrder(req: OrderRequest): Promise<{ orderId: number }>;
  cancelOrder(orderId: number): Promise<void>;
  onFill(cb: (fill: Fill) => void): void;
  /** advance simulated matching with fresh market data (paper only; no-op live) */
  markPrice(symbol: string, price: number): void;
}
