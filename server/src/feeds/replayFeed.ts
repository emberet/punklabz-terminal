import fs from 'node:fs';
import type { Candle } from '@punklabz/shared';
import { BaseFeed } from './feed.js';

/**
 * Deterministic feed for tests/offline dev. Loads candle fixtures
 * (JSON array of Candle, oldest first) and replays them either instantly
 * (speed=0, for tests) or on an accelerated clock.
 */
export class ReplayFeed extends BaseFeed {
  readonly name = 'replay';
  private candles: Candle[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private opts: { fixturePath?: string; candles?: Candle[]; intervalMs?: number } = {},
  ) {
    super();
    if (opts.candles) this.candles = opts.candles;
    else if (opts.fixturePath) {
      this.candles = JSON.parse(fs.readFileSync(opts.fixturePath, 'utf8')) as Candle[];
    }
  }

  async start(): Promise<void> {
    this.emitStatus(true, false);
    const intervalMs = this.opts.intervalMs ?? 0;
    if (intervalMs === 0) {
      // synchronous replay: emit everything now
      for (const c of this.candles) this.emitCandle(c);
      return;
    }
    let i = 0;
    this.timer = setInterval(() => {
      if (i >= this.candles.length) {
        this.stop();
        return;
      }
      this.emitCandle(this.candles[i++]);
    }, intervalMs);
  }

  private emitCandle(c: Candle) {
    this.lastMessageAt = Date.now();
    this.emit('tick', { symbol: c.symbol, price: c.c, changePct24h: 0 });
    this.emit('candle', c);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitStatus(false, false);
  }

  async backfill(): Promise<{ m1: Candle[]; h1: Candle[] }> {
    return { m1: [], h1: [] };
  }
}
