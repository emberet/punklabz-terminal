import { EventEmitter } from 'node:events';
import { INTERVAL_MS, type Candle, type Interval } from '@punklabz/shared';
import type { DB } from '../db/db.js';

/**
 * Candle store: persists 1m candles, aggregates 5m/15m/1h on the fly,
 * and emits 'candleClosed' (Candle) for every closed bar at every interval.
 * The engine subscribes here, never to raw feeds.
 */
export class CandleStore extends EventEmitter {
  constructor(private db: DB) {
    super();
  }

  /** bulk insert from backfill (no events emitted) */
  insertMany(candles: Candle[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO candles (symbol, interval, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: Candle[]) => {
      for (const c of rows) stmt.run(c.symbol, c.interval, c.ts, c.o, c.h, c.l, c.c, c.v);
    });
    tx(candles);
  }

  /** live 1m candle closed: persist, aggregate higher intervals, emit */
  ingest1m(c: Candle): void {
    this.insertMany([c]);
    this.emit('candleClosed', c);
    for (const interval of ['5m', '15m', '1h'] as Interval[]) {
      const agg = this.tryAggregate(c, interval);
      if (agg) {
        this.insertMany([agg]);
        this.emit('candleClosed', agg);
      }
    }
  }

  /** When c is the last 1m bar of an interval bucket, roll the bucket up. */
  private tryAggregate(c: Candle, interval: Interval): Candle | null {
    const ms = INTERVAL_MS[interval];
    const bucketStart = Math.floor(c.ts / ms) * ms;
    const isLastBar = c.ts + INTERVAL_MS['1m'] >= bucketStart + ms;
    if (!isLastBar) return null;
    const rows = this.db
      .prepare(
        `SELECT o, h, l, c, v, ts FROM candles
         WHERE symbol = ? AND interval = '1m' AND ts >= ? AND ts < ?
         ORDER BY ts ASC`,
      )
      .all(c.symbol, bucketStart, bucketStart + ms) as Candle[];
    if (rows.length === 0) return null;
    return {
      symbol: c.symbol,
      interval,
      ts: bucketStart,
      o: rows[0].o,
      h: Math.max(...rows.map((r) => r.h)),
      l: Math.min(...rows.map((r) => r.l)),
      c: rows[rows.length - 1].c,
      v: rows.reduce((s, r) => s + r.v, 0),
    };
  }

  history(symbol: string, interval: Interval, limit = 300): Candle[] {
    return (
      this.db
        .prepare(
          `SELECT symbol, interval, ts, o, h, l, c, v FROM candles
           WHERE symbol = ? AND interval = ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(symbol, interval, limit) as Candle[]
    ).reverse();
  }

  lastTs(symbol: string, interval: Interval): number | null {
    const row = this.db
      .prepare('SELECT MAX(ts) AS ts FROM candles WHERE symbol = ? AND interval = ?')
      .get(symbol, interval) as { ts: number | null };
    return row.ts;
  }

  /** prune 1m candles older than 7 days */
  prune(): void {
    this.db
      .prepare(`DELETE FROM candles WHERE interval = '1m' AND ts < ?`)
      .run(Date.now() - 7 * 24 * 3_600_000);
  }
}
