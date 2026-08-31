import { describe, expect, it } from 'vitest';
import type { Candle } from '@punklabz/shared';
import { openTestDb } from '../src/db/db.js';
import { CandleStore } from '../src/feeds/candles.js';
import { MemeFeed } from '../src/feeds/memeFeed.js';
import { WsHub } from '../src/realtime/wsHub.js';
import { OpportunityEngine } from '../src/live/opportunityEngine.js';

// a hub that records rather than sockets
const fakeHub = { publish() {}, publishThrottled() {} } as unknown as WsHub;

function trendTape(symbol: string, interval: Candle['interval'], n: number, rising: boolean): Candle[] {
  const step = interval === '5m' ? 300_000 : interval === '15m' ? 900_000 : 3_600_000;
  return Array.from({ length: n }, (_, i) => {
    const base = rising ? 1000 + i * 6 : 1000 - i * 6;
    return {
      symbol, interval, ts: 1_700_000_000_000 + i * step,
      o: base, h: base + 8, l: base - 8, c: base,
      v: i === n - 1 ? 900 : 100, // volume spike on the last bar
    };
  });
}

describe('opportunity engine', () => {
  it('scans real candles and produces signals with named edge models', () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    for (const iv of ['5m', '15m', '1h'] as const) {
      store.insertMany(trendTape('BTCUSDT', iv, 60, true));
    }
    // 1m history so the regime classifier has something to read
    store.insertMany(trendTape('BTCUSDT', '1m', 200, true));

    const engine = new OpportunityEngine(db, store, new MemeFeed(), fakeHub);
    const counts = engine.runPass();

    expect(counts.marketsObserved).toBeGreaterThanOrEqual(3); // three majors observed
    expect(counts.scansPerformed).toBeGreaterThanOrEqual(9); // 3 symbols × 3 intervals
    expect(counts.candidates).toBeGreaterThan(0);

    const opps = db.prepare(`SELECT * FROM opportunities`).all() as any[];
    expect(opps.length).toBe(counts.signals);
    for (const o of opps) {
      expect(o.edge_model).toMatch(/^atr_excursion_/);
      // the accounting identity holds on every row
      expect(o.net_edge_bps).toBeCloseTo(
        o.gross_edge_bps - o.fee_bps - o.slippage_bps - o.buffer_bps, 6,
      );
      expect(JSON.parse(o.evidence_json)).toBeTypeOf('object');
    }
  });

  it('records a scan pass with measured counts and duration', () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    store.insertMany(trendTape('ETHUSDT', '15m', 60, false));
    const engine = new OpportunityEngine(db, store, new MemeFeed(), fakeHub);
    engine.runPass();

    const pass = db.prepare(`SELECT * FROM scan_passes ORDER BY id DESC LIMIT 1`).get() as any;
    expect(pass.markets_observed).toBeGreaterThan(0);
    expect(pass.scans_performed).toBeGreaterThan(0);
    expect(pass.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('signals whose edge cannot pay costs are stored as rejected', () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    // an extremely low-volatility tape: tiny ATR, so any signal fails net edge
    const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      symbol: 'SOLUSDT', interval: '15m' as const, ts: 1_700_000_000_000 + i * 900_000,
      o: 100, h: 100.01, l: 99.99, c: i > 55 ? 100.005 : 100,
      v: i === 59 ? 900 : 100,
    }));
    store.insertMany(flat);
    const engine = new OpportunityEngine(db, store, new MemeFeed(), fakeHub);
    engine.runPass();

    const rows = db.prepare(`SELECT state, net_edge_bps FROM opportunities`).all() as any[];
    for (const r of rows) {
      if (r.net_edge_bps <= 0) expect(r.state).toBe('rejected');
    }
  });

  it('prunes its own history so it can run forever', () => {
    const db = openTestDb();
    const store = new CandleStore(db);
    db.prepare(
      `INSERT INTO opportunities (ts, scanner, universe, instrument_id, symbol, direction, confidence,
        gross_edge_bps, fee_bps, slippage_bps, buffer_bps, net_edge_bps, edge_model, evidence_json, state)
       VALUES (?, 'old', 'majors', 'x', 'X', 'buy', 50, 1, 1, 1, 1, -2, 'm', '{}', 'rejected')`,
    ).run(Date.now() - 48 * 3_600_000);
    new OpportunityEngine(db, store, new MemeFeed(), fakeHub).runPass();
    const old = db.prepare(`SELECT COUNT(*) n FROM opportunities WHERE scanner = 'old'`).get() as { n: number };
    expect(old.n).toBe(0);
  });
});
