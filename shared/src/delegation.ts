// Non-custodial delegation: shared types.
//
// A user grants their bot scoped authority to trade THEIR wallet. PunkLabz
// never holds the key — the provider does — and never holds the funds.

export type GrantStatus = 'pending' | 'active' | 'paused' | 'revoked' | 'expired' | 'exhausted';

export interface DelegationCaps {
  perTradeUsd: number;
  dailyUsd: number;
  cumulativeUsd: number;
  maxOpenNotionalUsd: number;
  maxSlippageBps: number;
}

export interface DelegationCeiling {
  tier: number;
  perTradeUsd: number;
  dailyUsd: number;
  cumulativeUsd: number;
  maxGrantsPerUser: number;
  maxTotalDelegatedUsd: number;
  externallyAudited: boolean;
  /** what the next tier needs, named — empty when already at the top */
  blockers: string[];
  evidence: Record<string, unknown>;
}

/**
 * The ceiling ladder. Tier 0 is $0: delegation is fully built and testable but
 * cannot move a cent until this network has a live track record. A tier is
 * EARNED from measured evidence; there is no code path that buys one.
 */
export const CEILING_TIERS = [
  {
    tier: 0,
    perTradeUsd: 0, dailyUsd: 0, cumulativeUsd: 0,
    maxGrantsPerUser: 0, maxTotalDelegatedUsd: 0,
    requires: 'no live track record yet',
  },
  {
    tier: 1,
    perTradeUsd: 5, dailyUsd: 10, cumulativeUsd: 25,
    maxGrantsPerUser: 1, maxTotalDelegatedUsd: 250,
    requires: 'live mode, 25 clean live fills, 14 days live, clean reconciliation, no failed orders',
  },
  {
    tier: 2,
    perTradeUsd: 25, dailyUsd: 50, cumulativeUsd: 250,
    maxGrantsPerUser: 3, maxTotalDelegatedUsd: 5_000,
    requires: '250 fills, 60 days live, 30 days drift-free reconciliation, no halts in 30 days',
  },
  {
    tier: 3,
    perTradeUsd: 100, dailyUsd: 500, cumulativeUsd: 2_500,
    maxGrantsPerUser: 5, maxTotalDelegatedUsd: 50_000,
    requires: '2000 fills, 180 days live, external audit',
  },
] as const;

export interface GrantView {
  id: number;
  userId: number;
  botId: number;
  botName: string | null;
  walletAddress: string;
  chainId: number;
  status: GrantStatus;
  caps: DelegationCaps;
  /** what the user asked for, before the ceiling clamped it */
  requestedCaps: DelegationCaps | null;
  clampedFields: string[];
  ceilingTier: number;
  spentUsd: number;
  spentTodayUsd: number;
  reservedUsd: number;
  headroomUsd: number;
  expiresAt: number;
  createdAt: number;
  providerBound: boolean;
  revokeReason: string | null;
}

export interface RevocationResult {
  revoked: boolean;
  inFlightCancelled: number;
  /** already submitted to a venue — cannot be un-sent. The UI must say so. */
  unstoppable: number[];
  providerRevoked: boolean;
  detail: string;
}

export const DELEGATION_CONSENT_TEXT = [
  'I authorise this PunkLabz machine to submit trades from my wallet within the',
  'limits below. I understand that:',
  '  - PunkLabz never holds my private key and never holds my funds.',
  '  - I can revoke this authority at any time, instantly, without permission.',
  '  - A trade already submitted to a venue cannot be recalled.',
  '  - This software is experimental and can lose money, including through bugs.',
  '  - Nothing here is financial advice, and no return is promised or implied.',
].join('\n');
