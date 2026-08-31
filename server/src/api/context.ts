import type { DB } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { PaperExecutor } from '../execution/paperExecutor.js';
import type { CandleStore } from '../feeds/candles.js';
import type { WsHub } from '../realtime/wsHub.js';
import type { HolderSource } from '../manager/holderSource.js';
import type { PayoutQueue } from '../manager/payoutQueue.js';
import type { MemeFeed } from '../feeds/memeFeed.js';
import type { NewsFeed } from '../feeds/newsFeed.js';
import type { OpportunityEngine } from '../live/opportunityEngine.js';
import type { TradingSigner } from '../live/signing/signer.js';
import type { ExecutionAdapter } from '../live/adapters.js';

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
  memeFeed: MemeFeed;
  newsFeed: NewsFeed;
  opportunities?: OpportunityEngine;
  signer: TradingSigner;
  adapters: Map<string, ExecutionAdapter>;
}
