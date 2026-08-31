import { getAddress, formatUnits, type Address } from 'viem';
import { ROBINHOOD_MAINNET_CHAIN_ID, USDG } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { rhClient } from './rhChain.js';
import { listAssets } from '../robinhood/assetRegistry.js';
import { parseMultiplier } from '../robinhood/multiplier.js';
import { fetchReferenceQuote, lastReferenceQuote } from '../robinhood/referencePrice.js';

// WALLET BALANCES, READ FROM THE CHAIN.
//
// The chain is authoritative. Nothing here reads a cached balance from our own
// database and presents it as the wallet's contents — if the RPC cannot
// answer, the caller is told so rather than shown a stale number that looks
// current.
//
// Every balance carries the decimals it was scaled by, because they are not
// uniform: stock tokens are 18 and USDG is 6. Formatting a USDG balance with
// 18 decimals shows a millionth of the real figure.
//
// Valuation is separated from balances on purpose. A balance is a fact. A USD
// value is an estimate built from a reference price that may be stale, and the
// two must not be presented with the same confidence.

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface TokenBalance {
  symbol: string;
  name: string;
  assetClass: string;
  contractAddress: string | null;
  /** raw integer units as the contract reports them */
  raw: string;
  decimals: number;
  /** human-readable token amount */
  amount: number;
  /** underlying-share exposure for a scaled-UI stock token; null otherwise */
  underlyingExposure: number | null;
  multiplier: string | null;
  /** null when we have no honest price for it */
  usdValue: number | null;
  priceSource: 'reference' | 'mark' | 'par' | null;
  priceStale: boolean;
}

export interface Portfolio {
  address: string;
  chainId: number;
  ok: boolean;
  error: string | null;
  gas: TokenBalance;
  settlement: TokenBalance;
  tokens: TokenBalance[];
  /** sum of every position we could price; positions we could not are counted separately */
  totalUsd: number;
  unpricedCount: number;
  /** true when at least one component price was stale */
  degraded: boolean;
  fetchedAt: number;
}

const zero = (symbol: string, name: string, assetClass: string, decimals: number, contractAddress: string | null): TokenBalance => ({
  symbol, name, assetClass, contractAddress, raw: '0', decimals, amount: 0,
  underlyingExposure: null, multiplier: null, usdValue: 0, priceSource: null, priceStale: false,
});

/**
 * Price one Robinhood asset in USD.
 *
 * Stock tokens are priced as `underlying reference × multiplier` — the token
 * is worth the multiplier's worth of shares, and using the raw reference price
 * would understate a 4x-multiplier position by 75%.
 */
function priceAsset(
  db: DB,
  symbol: string,
  assetClass: string,
  multiplier: bigint,
): { usd: number | null; source: TokenBalance['priceSource']; stale: boolean } {
  if (assetClass === 'STABLECOIN') {
    // USDG is fiat-backed and redeemable 1:1. Par is the honest label — this
    // is not a market quote and must not be dressed up as one.
    return { usd: 1, source: 'par', stale: false };
  }
  const quote = lastReferenceQuote(db, symbol);
  if (!quote) return { usd: null, source: null, stale: false };
  const perToken = quote.mid * (Number(multiplier) / 1e18);
  return { usd: perToken, source: 'reference', stale: quote.stale };
}

export interface PortfolioOptions {
  chainId?: number;
  /** price ETH from the paper feed's mark, the only ETH/USD we measure */
  ethUsd?: number | null;
  /** cap the token scan; the registry is ~194 assets and multicall batches them */
  maxTokens?: number;
  /** cap live price fetches per call; the rest fall back to cached or unpriced */
  maxPriceFetches?: number;
}

export async function readPortfolio(
  db: DB,
  walletAddress: string,
  opts: PortfolioOptions = {},
): Promise<Portfolio> {
  const chainId = opts.chainId ?? ROBINHOOD_MAINNET_CHAIN_ID;
  const address = getAddress(walletAddress) as Address;
  const fetchedAt = Date.now();

  const empty: Portfolio = {
    address, chainId, ok: false, error: null,
    gas: zero('ETH', 'Ether', 'GAS', 18, null),
    settlement: zero(USDG.symbol, USDG.name, 'STABLECOIN', USDG.decimals, USDG.address.toLowerCase()),
    tokens: [], totalUsd: 0, unpricedCount: 0, degraded: false, fetchedAt,
  };

  const client = rhClient(chainId);

  // every registry asset we could hold, minus the settlement asset itself
  const assets = listAssets(db, { limit: opts.maxTokens ?? 250 })
    .filter((a) => a.contractAddress.toLowerCase() !== USDG.address.toLowerCase());

  let nativeWei: bigint;
  let usdgRaw: bigint;
  let tokenResults: { status: string; result?: unknown }[];

  try {
    // One multicall for every ERC-20, plus the native balance. Multicall3 is
    // deployed at the canonical address on this chain, so 194 balances cost
    // one round trip rather than 194.
    const [native, usdg, batch] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({
        address: getAddress(USDG.address), abi: ERC20_ABI, functionName: 'balanceOf', args: [address],
      }) as Promise<bigint>,
      // An empty registry is an ordinary state — a fresh install, or one whose
      // first refresh has not run yet — and it must still show ETH and USDG
      // rather than failing the whole portfolio.
      assets.length === 0
        ? Promise.resolve([])
        : client.multicall({
            contracts: assets.map((a) => ({
              address: getAddress(a.contractAddress) as Address,
              abi: ERC20_ABI,
              functionName: 'balanceOf' as const,
              args: [address] as const,
            })),
            allowFailure: true,
          }),
    ]);
    nativeWei = native;
    usdgRaw = usdg;
    tokenResults = batch as { status: string; result?: unknown }[];
  } catch (e) {
    return {
      ...empty,
      error: `could not read balances from chain ${chainId}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`,
    };
  }

  let degraded = false;
  let unpricedCount = 0;
  let totalUsd = 0;

  // ── gas (native ETH) ──
  const ethAmount = Number(formatUnits(nativeWei, 18));
  const ethUsd = opts.ethUsd ?? null;
  const gas: TokenBalance = {
    symbol: 'ETH', name: 'Ether', assetClass: 'GAS', contractAddress: null,
    raw: nativeWei.toString(), decimals: 18, amount: ethAmount,
    underlyingExposure: null, multiplier: null,
    usdValue: ethUsd !== null ? ethAmount * ethUsd : null,
    priceSource: ethUsd !== null ? 'mark' : null,
    priceStale: false,
  };
  if (gas.usdValue !== null) totalUsd += gas.usdValue;
  else if (ethAmount > 0) unpricedCount++;

  // ── settlement (USDG, SIX decimals) ──
  const usdgAmount = Number(formatUnits(usdgRaw, USDG.decimals));
  const settlement: TokenBalance = {
    symbol: USDG.symbol, name: USDG.name, assetClass: 'STABLECOIN',
    contractAddress: USDG.address.toLowerCase(),
    raw: usdgRaw.toString(), decimals: USDG.decimals, amount: usdgAmount,
    underlyingExposure: null, multiplier: null,
    usdValue: usdgAmount, priceSource: 'par', priceStale: false,
  };
  totalUsd += usdgAmount;

  // ── everything else the wallet actually holds ──
  const held: { asset: (typeof assets)[number]; raw: bigint }[] = [];
  for (let i = 0; i < assets.length; i++) {
    const outcome = tokenResults[i];
    if (!outcome || outcome.status !== 'success') continue;
    const raw = outcome.result as bigint;
    if (raw && raw !== 0n) held.push({ asset: assets[i], raw }); // only report what is held
  }

  // Fetch a live reference price for anything held without a fresh cached one,
  // so a first-time connect shows values rather than a column of dashes. The
  // asset API is keyless at 60 req/s; the cap keeps a wallet holding the whole
  // universe (market makers do) from turning one page load into 194 requests.
  const toPrice = held
    .filter(({ asset }) => asset.assetClass !== 'STABLECOIN')
    .filter(({ asset }) => {
      const cached = lastReferenceQuote(db, asset.symbol);
      return !cached || cached.stale;
    })
    .slice(0, opts.maxPriceFetches ?? 25);
  await Promise.all(
    toPrice.map(({ asset }) => fetchReferenceQuote(db, asset.symbol).catch(() => null)),
  );

  const tokens: TokenBalance[] = [];
  for (const { asset, raw } of held) {
    const multiplier = parseMultiplier(asset.multiplier);
    const amount = Number(formatUnits(raw, asset.decimals));
    const priced = priceAsset(db, asset.symbol, asset.assetClass, multiplier);
    if (priced.stale) degraded = true;

    const usdValue = priced.usd !== null ? amount * priced.usd : null;
    if (usdValue !== null) totalUsd += usdValue;
    else unpricedCount++;

    tokens.push({
      symbol: asset.symbol,
      name: asset.name,
      assetClass: asset.assetClass,
      contractAddress: asset.contractAddress,
      raw: raw.toString(),
      decimals: asset.decimals,
      amount,
      underlyingExposure:
        asset.assetClass === 'STOCK_TOKEN' || asset.assetClass === 'ETF_TOKEN'
          ? amount * (Number(multiplier) / 1e18)
          : null,
      multiplier: asset.multiplier,
      usdValue,
      priceSource: priced.source,
      priceStale: priced.stale,
    });
  }

  tokens.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));

  return {
    address, chainId, ok: true, error: null,
    gas, settlement, tokens,
    totalUsd, unpricedCount, degraded, fetchedAt,
  };
}
