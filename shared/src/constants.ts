// Money is stored as integer micro-USD (1 USD = 1_000_000 micro).
export const MICRO = 1_000_000;

export const FEES = {
  /** one-time bot creation fee, paid by quant -> platform */
  creationUsd: 20,
  /** clone/reuse fee, paid by cloner -> 100% to original creator */
  reuseUsd: 10,
  /** flat per-trade tax on quant bots, owner -> platform */
  tradeTaxUsd: 1,
  /** demo credit seeded on signup (mock billing) */
  signupSeedUsd: 100,
} as const;

/** PunkLabz holders need at least this many tokens to receive payouts. */
export const HOLDER_THRESHOLD = 1_000_000;

export const MAJOR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
export type MajorSymbol = (typeof MAJOR_SYMBOLS)[number];

export const INTERVALS = ['1m', '5m', '15m', '1h'] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

/** paper-execution friction */
export const PAPER = {
  majorSlippageBps: 5,
  pumpSlippagePct: 1.5,
  feeBps: 10,
} as const;

export const MAX_BOTS_PER_USER = 5;
export const HOUSE_INITIAL_BALANCE_USD = 10_000;
export const QUANT_INITIAL_BALANCE_USD = 10_000;
