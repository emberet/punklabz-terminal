import { EventEmitter } from 'node:events';
import type { Candle } from '@punklabz/shared';

export interface TickEvent {
  symbol: string;
  price: number;
  changePct24h: number;
}

/**
 * A market data source for the majors. Emits:
 *  - 'tick'    (TickEvent)         live mark price
 *  - 'candle'  (Candle)            CLOSED 1m candle
 *  - 'status'  ({connected, stale})
 */
export interface Feed extends EventEmitter {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  /** REST backfill of recent 1m + 1h candles, called once on boot */
  backfill(symbol: string): Promise<{ m1: Candle[]; h1: Candle[] }>;
}

export abstract class BaseFeed extends EventEmitter implements Feed {
  abstract readonly name: string;
  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract backfill(symbol: string): Promise<{ m1: Candle[]; h1: Candle[] }>;

  protected connected = false;
  protected lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  protected reconnectAttempt = 0;

  protected startWatchdog(onStale: () => void, timeoutMs = 30_000) {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastMessageAt > timeoutMs) {
        this.emitStatus(true, true);
        onStale();
      }
    }, 10_000);
  }

  protected stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  protected emitStatus(connected: boolean, stale: boolean) {
    this.connected = connected;
    this.emit('status', { connected, stale });
  }

  /** exponential backoff with jitter, 1s -> 60s cap */
  protected backoffMs(): number {
    const base = Math.min(60_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    return base / 2 + Math.random() * (base / 2);
  }
}
