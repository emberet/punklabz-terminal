import { describe, expect, it } from 'vitest';
import type { Candle } from '@punklabz/shared';
import { rrProbability } from '../src/analysis/rr.js';

function candle(i: number, c: number, h = c + 1, l = c - 1): Candle {
  return { symbol: 'BTCUSDT', interval: '1m', ts: i * 60_000, o: c, h, l, c, v: 1 };
}

describe('rr probability', () => {
  it('a steadily rising tape hits targets, never stops', () => {
    const tape = Array.from({ length: 500 }, (_, i) => candle(i, 1000 + i * 2, 1000 + i * 2 + 0.5, 1000 + i * 2 - 0.5));
    const r = rrProbability(tape, { stopPct: 5, targetPct: 2, sampleStride: 5 });
    expect(r.losses).toBe(0);
    expect(r.pWin).toBe(1);
    expect(r.expectancyPct).toBeCloseTo(2);
  });

  it('a steadily falling tape stops out', () => {
    const tape = Array.from({ length: 500 }, (_, i) => candle(i, 2000 - i * 2, 2000 - i * 2 + 0.5, 2000 - i * 2 - 0.5));
    const r = rrProbability(tape, { stopPct: 2, targetPct: 5, sampleStride: 5 });
    expect(r.wins).toBe(0);
    expect(r.pWin).toBe(0);
    expect(r.expectancyPct).toBeCloseTo(-2);
  });

  it('leverage scales gains, losses and liquidation distance', () => {
    const tape = Array.from({ length: 300 }, (_, i) => candle(i, 1000 + Math.sin(i / 10) * 30));
    const r = rrProbability(tape, { stopPct: 2, targetPct: 4, leverage: 5 });
    expect(r.rrRatio).toBe(2);
    expect(r.leveragedGainPct).toBe(20);
    expect(r.leveragedLossPct).toBe(10);
    expect(r.liquidationStopPct).toBe(20);
    expect(r.leveragedExpectancyPct).toBeCloseTo(r.expectancyPct * 5, 8);
  });

  it('both-sides-in-one-bar counts as a loss (conservative) and is deterministic', () => {
    // huge wicks touch both stop and target every bar
    const tape = Array.from({ length: 100 }, (_, i) => candle(i, 1000, 1200, 800));
    const a = rrProbability(tape, { stopPct: 1, targetPct: 1 });
    expect(a.wins).toBe(0);
    expect(a.losses).toBeGreaterThan(0);
    const b = rrProbability(tape, { stopPct: 1, targetPct: 1 });
    expect(a).toEqual(b);
  });
});
