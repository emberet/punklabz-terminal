import type { Executor, Fill, OrderRequest } from './executor.js';

/**
 * Placeholder for real-money execution. Swapping this in later means:
 * implement placeOrder/cancelOrder against a venue API (or on-chain swap),
 * emit fills via onFill — the engine and accounting need no changes.
 */
export class LiveExecutor implements Executor {
  placeOrder(_req: OrderRequest): Promise<{ orderId: number }> {
    throw new Error('LiveExecutor NOT_IMPLEMENTED: real-money trading is not enabled');
  }
  cancelOrder(_orderId: number): Promise<void> {
    throw new Error('LiveExecutor NOT_IMPLEMENTED');
  }
  onFill(_cb: (fill: Fill) => void): void {}
  markPrice(): void {}
}
