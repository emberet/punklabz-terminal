// ROBINHOOD CHAIN — the home network.
//
// Explicit configuration, NOT a renamed Base config. Everything here was
// verified against the live chain and the official asset API on 2026-08-31:
// eth_chainId returned 0x1237 (4663), and every one of the 194 assets the
// registry serves reports chainId 4663 with 18 decimals.
//
// The single most important fact in this file is DECIMALS ARE NOT UNIFORM.
// Stock tokens are 18; USDG — the settlement asset every trade is denominated
// in — is 6. Verified onchain. Assuming 18 across the board puts every USDG
// amount out by a factor of 1e12, which is the difference between a $5 order
// and a $5,000,000,000,000 one. Nothing in this codebase may hardcode a
// decimals value; it comes from the registry, which reads it from the token.

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export interface ChainMeta {
  chainId: number;
  name: string;
  shortName: string;
  /** gas is ETH, not a native token of its own */
  gasSymbol: string;
  explorerUrl: string;
  publicRpcUrl: string;
  isTestnet: boolean;
}

export const ROBINHOOD_CHAINS: Record<number, ChainMeta> = {
  [ROBINHOOD_MAINNET_CHAIN_ID]: {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    name: 'Robinhood Chain',
    shortName: 'RH',
    gasSymbol: 'ETH',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    // documented as rate-limited and explicitly NOT for production use
    publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    isTestnet: false,
  },
  [ROBINHOOD_TESTNET_CHAIN_ID]: {
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    shortName: 'RH-TEST',
    gasSymbol: 'ETH',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    publicRpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    isTestnet: true,
  },
};

/** The settlement asset. 6 decimals — verified onchain, NOT 18. */
export const USDG = {
  symbol: 'USDG',
  name: 'Global Dollar',
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  decimals: 6,
  chainId: ROBINHOOD_MAINNET_CHAIN_ID,
} as const;

export const WETH_ROBINHOOD = {
  symbol: 'WETH',
  address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  decimals: 18,
  chainId: ROBINHOOD_MAINNET_CHAIN_ID,
} as const;

/** Robinhood-chain asset taxonomy. Distinct from the venue-level `AssetClass`
 *  in live.ts, which describes market structure rather than token type. */
export type RhAssetClass = 'CRYPTO' | 'STOCK_TOKEN' | 'ETF_TOKEN' | 'RWA' | 'STABLECOIN';

/**
 * What an instrument is allowed to do right now. Deliberately ordered from
 * least to most permissive so a comparison can express "at least".
 */
export const ELIGIBILITY_STATES = [
  'BLOCKED',
  'RESEARCH_ONLY',
  'SHADOW_ONLY',
  'CANARY_ALLOWED',
  'LIVE_ALLOWED',
] as const;
export type EligibilityState = (typeof ELIGIBILITY_STATES)[number];

export function atLeast(state: EligibilityState, required: EligibilityState): boolean {
  return ELIGIBILITY_STATES.indexOf(state) >= ELIGIBILITY_STATES.indexOf(required);
}

/**
 * STOCK TOKEN SEMANTICS — the copy rules, in code so they cannot drift.
 *
 * Robinhood Stock Tokens are tokenized DEBT SECURITIES issued by Robinhood
 * Assets (Jersey) Limited. A holder has economic exposure to the underlying
 * and a claim on the ISSUER — not on the company, and not on any share. No
 * voting rights, no shareholder rights, no ownership. If the issuer fails, the
 * holder is an unsecured creditor.
 *
 * The UI must never say a user "owns" the underlying company's shares.
 */
export const STOCK_TOKEN_ISSUER = {
  name: 'Robinhood Assets (Jersey) Limited',
  short: 'RHJ',
  jurisdiction: 'Jersey',
  registrationNumber: '162428',
  instrumentType: 'tokenized debt security',
} as const;

export const STOCK_TOKEN_DISCLOSURE =
  'A Stock Token is a tokenized debt security issued by Robinhood Assets (Jersey) Limited. ' +
  'It gives economic exposure to the underlying, not ownership of it: no shares, no voting ' +
  'rights, no shareholder rights, and no claim against the underlying company. Holders carry ' +
  'credit risk to the issuer.';

/** Words this product may not use about a Stock Token position. */
export const FORBIDDEN_OWNERSHIP_TERMS = [
  'you own', 'your shares', 'shareholder', 'equity stake', 'ownership of',
  'own apple', 'own nvidia', 'buy shares', 'shares of',
] as const;

export interface RhAssetView {
  symbol: string;
  name: string;
  underlyingSymbol: string;
  assetClass: RhAssetClass;
  contractAddress: string;
  chainId: number;
  decimals: number;
  /** 1.0 = unadjusted. NOT always 1 — 8 of 194 live assets differ today. */
  multiplier: string;
  pendingMultiplier: string | null;
  pendingEffectiveAt: number | null;
  isin: string | null;
  status: string;
  tradable: boolean;
  eligibility: EligibilityState;
  verifiedOnchain: boolean;
  lastVerifiedAt: number;
}

export interface ReferenceQuote {
  symbol: string;
  /** RAW UNDERLYING price — per the API docs, NOT multiplier-adjusted */
  bid: number;
  ask: number;
  mid: number;
  currency: string;
  isTradingHalt: boolean;
  generatedAt: number;
  ageMs: number;
  stale: boolean;
}
