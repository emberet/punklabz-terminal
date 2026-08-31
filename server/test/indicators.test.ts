import { describe, expect, it } from 'vitest';
import { bollinger, crossAbove, crossBelow, ema, rsi, sma } from '../src/engine/indicators.js';

describe('indicators', () => {
  it('sma matches hand computation', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4); // last 3
    expect(sma([1, 2], 3)).toBeNull();
  });

  it('ema seeds with sma and smooths', () => {
    // period 3, k = 0.5: seed sma(1,2,3)=2; then 2+0.5*(10-2)=6
    expect(ema([1, 2, 3, 10], 3)).toBe(6);
  });

  it('rsi: all gains -> 100, balanced -> 50', () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8], 7)).toBe(100);
    const balanced = [10, 11, 10, 11, 10, 11, 10, 11, 10];
    const r = rsi(balanced, 8);
    expect(r).not.toBeNull();
    expect(Math.abs(r! - 50)).toBeLessThan(7);
  });

  it('bollinger bands bracket the mean symmetrically', () => {
    const closes = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16];
    const bb = bollinger(closes, 10, 2)!;
    const mid = sma(closes, 10)!;
    expect(bb.upper - mid).toBeCloseTo(mid - bb.lower, 10);
    expect(bb.upper).toBeGreaterThan(bb.lower);
  });

  it('cross detection uses the last two bars only', () => {
    expect(crossAbove([1, 3], [2, 2])).toBe(true);
    expect(crossAbove([3, 4], [2, 2])).toBe(false); // already above
    expect(crossBelow([3, 1], [2, 2])).toBe(true);
    expect(crossBelow([1, 0.5], [2, 2])).toBe(false); // already below
  });
});
