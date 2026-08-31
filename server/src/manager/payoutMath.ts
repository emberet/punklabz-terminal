import { createHash } from 'node:crypto';
import { HOLDER_THRESHOLD } from '@punklabz/shared';

// Pure deterministic payout math. No I/O, no Date.now(), no Claude.
// Every number here is re-derivable from its inputs; managerAgent.ts narrates
// results but can never alter them.

export interface HolderBalance {
  address: string;
  balance: number; // whole PunkLabz tokens
}

export interface PayoutShare {
  address: string;
  balance: number;
  amountMicro: number;
}

export interface PayoutResult {
  eligible: PayoutShare[];
  eligibleSupply: number;
  distributedMicro: number;
  dustMicro: number; // rounding remainder -> platform
}

/** Epoch profit = sum of house realized PnL in the window, floored at 0. */
export function computeEpochProfitMicro(realizedPnlMicros: number[]): number {
  const total = realizedPnlMicros.reduce((a, b) => a + b, 0);
  return Math.max(0, total);
}

/**
 * Pro-rata distribution among holders at/above the 1M threshold.
 * amount_i = floor(profit * balance_i / eligibleSupply); dust goes to platform.
 * Invariant (asserted): sum(amounts) + dust === profit.
 */
export function computePayouts(profitMicro: number, holders: HolderBalance[]): PayoutResult {
  if (!Number.isInteger(profitMicro) || profitMicro < 0)
    throw new Error('profitMicro must be a non-negative integer');
  const eligibleHolders = holders
    .filter((h) => h.balance >= HOLDER_THRESHOLD)
    .sort((a, b) => a.address.localeCompare(b.address)); // deterministic order
  const eligibleSupply = eligibleHolders.reduce((s, h) => s + h.balance, 0);

  if (profitMicro === 0 || eligibleSupply === 0) {
    return { eligible: [], eligibleSupply, distributedMicro: 0, dustMicro: profitMicro };
  }

  const eligible: PayoutShare[] = eligibleHolders.map((h) => ({
    address: h.address,
    balance: h.balance,
    // BigInt: profit * balance can exceed 2^53
    amountMicro: Number((BigInt(profitMicro) * BigInt(h.balance)) / BigInt(eligibleSupply)),
  }));
  const distributedMicro = eligible.reduce((s, e) => s + e.amountMicro, 0);
  const dustMicro = profitMicro - distributedMicro;

  if (distributedMicro + dustMicro !== profitMicro || dustMicro < 0) {
    throw new Error(
      `payout invariant violated: distributed ${distributedMicro} + dust ${dustMicro} != profit ${profitMicro}`,
    );
  }
  return { eligible, eligibleSupply, distributedMicro, dustMicro };
}

/** Canonical hash of an epoch's inputs so any epoch can be re-derived and checked. */
export function epochInputsHash(args: {
  periodStart: number;
  periodEnd: number;
  realizedPnlMicros: number[];
  holders: HolderBalance[];
}): string {
  const canonical = JSON.stringify({
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    pnl: args.realizedPnlMicros,
    holders: [...args.holders].sort((a, b) => a.address.localeCompare(b.address)),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
