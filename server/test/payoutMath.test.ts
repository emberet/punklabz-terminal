import { describe, expect, it } from 'vitest';
import {
  computeEpochProfitMicro,
  computePayouts,
  epochInputsHash,
  type HolderBalance,
} from '../src/manager/payoutMath.js';
import { HOLDER_THRESHOLD } from '@punklabz/shared';

function randHolders(n: number, seed: number): HolderBalance[] {
  // deterministic LCG so failures reproduce
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2 ** 31);
  return Array.from({ length: n }, (_, i) => ({
    address: `H${i}_${seed}`,
    balance: next() % 60_000_000,
  }));
}

describe('computeEpochProfitMicro', () => {
  it('sums and floors at zero', () => {
    expect(computeEpochProfitMicro([5_000_000, -2_000_000])).toBe(3_000_000);
    expect(computeEpochProfitMicro([-10_000_000, 2_000_000])).toBe(0);
    expect(computeEpochProfitMicro([])).toBe(0);
  });
});

describe('computePayouts', () => {
  it('invariant: distributed + dust === profit (property, 200 cases)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const profit = (seed * 7_919_113) % 500_000_000;
      const holders = randHolders(seed % 30, seed);
      const r = computePayouts(profit, holders);
      expect(r.distributedMicro + r.dustMicro).toBe(profit);
      expect(r.dustMicro).toBeGreaterThanOrEqual(0);
    }
  });

  it('excludes holders below the 1M threshold', () => {
    const r = computePayouts(100_000_000, [
      { address: 'whale', balance: 2_000_000 },
      { address: 'shrimp', balance: HOLDER_THRESHOLD - 1 },
    ]);
    expect(r.eligible.map((e) => e.address)).toEqual(['whale']);
    expect(r.eligible[0].amountMicro).toBe(100_000_000);
  });

  it('is pro-rata and monotonic in balance', () => {
    const r = computePayouts(1_000_000_000, [
      { address: 'a', balance: 1_000_000 },
      { address: 'b', balance: 3_000_000 },
    ]);
    const a = r.eligible.find((e) => e.address === 'a')!;
    const b = r.eligible.find((e) => e.address === 'b')!;
    expect(b.amountMicro).toBe(a.amountMicro * 3);
  });

  it('zero profit or no eligible holders -> everything is dust', () => {
    expect(computePayouts(0, [{ address: 'a', balance: 2_000_000 }]).distributedMicro).toBe(0);
    const r = computePayouts(5_000_000, [{ address: 'a', balance: 10 }]);
    expect(r.distributedMicro).toBe(0);
    expect(r.dustMicro).toBe(5_000_000);
  });

  it('handles balances that overflow float math via BigInt', () => {
    const r = computePayouts(123_456_789_012, [
      { address: 'a', balance: 48_000_000_000 },
      { address: 'b', balance: 1_000_000 },
    ]);
    expect(r.distributedMicro + r.dustMicro).toBe(123_456_789_012);
  });

  it('rejects non-integer profit', () => {
    expect(() => computePayouts(1.5, [])).toThrow();
  });
});

describe('epochInputsHash', () => {
  it('is order-independent for holders and sensitive to values', () => {
    const base = { periodStart: 1, periodEnd: 2, realizedPnlMicros: [10, -5] };
    const h1 = epochInputsHash({ ...base, holders: [{ address: 'a', balance: 1 }, { address: 'b', balance: 2 }] });
    const h2 = epochInputsHash({ ...base, holders: [{ address: 'b', balance: 2 }, { address: 'a', balance: 1 }] });
    const h3 = epochInputsHash({ ...base, holders: [{ address: 'a', balance: 9 }, { address: 'b', balance: 2 }] });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
