import type { DB } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { PaperExecutor } from '../execution/paperExecutor.js';
import type { CandleStore } from '../feeds/candles.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { HolderSource } from '../manager/holderSource.js';
import type { PayoutQueue } from '../manager/payoutQueue.js';

export interface AppContext {
  db: DB;
  engine: Engine;
  executor: PaperExecutor;
  candles: CandleStore;
  hub: WsHub;
  holderSource: HolderSource;
  payoutQueue: PayoutQueue;
  feedStatus: Record<string, { connected: boolean; stale: boolean }>;
  prices: Record<string, { price: number; changePct24h: number }>;
}
