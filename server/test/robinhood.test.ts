import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  ROBINHOOD_MAINNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, USDG, WETH_ROBINHOOD,
  STOCK_TOKEN_ISSUER, atLeast,
} from '@punklabz/shared';
import {
  MULTIPLIER_SCALE, formatMultiplier, measureDislocation, multiplierAt,
  normalizeStockTokenPrice, normalizeUnderlyingExposure, parseMultiplier,
  pendingMultiplier, recordMultiplier, tokenAmountForExposure,
} from '../src/robinhood/multiplier.js';
import { blocksTrading, corporateActionState, refreshCorporateActions } from '../src/robinhood/corporateActions.js';
import { referencePriceGate, lastReferenceQuote, fetchReferenceQuote } from '../src/robinhood/referencePrice.js';
import { classifyAsset, getAsset, refreshRegistry, registryStatus, seedCoreTokens } from '../src/robinhood/assetRegistry.js';
import { evaluateEligibility, resolveRobinhoodInstrument } from '../src/robinhood/instrumentResolver.js';

const M = (s: string) => parseMultiplier(s);

/** the real CRWD numbers, captured from the live API and chain on 2026-08-31 */
const CRWD = {
  address: '0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931',
  multiplier: '4.000000000000000000',
  underlyingBid: 218.03,
  underlyingAsk: 219,
};

function seedAsset(db: DB, over: Record<string, unknown> = {}) {
  const now = Date.now();
  const row = {
    symbol: 'CRWD', chain_id: ROBINHOOD_MAINNET_CHAIN_ID, contract_address: CRWD.address,
    name: 'CrowdStrike Holdings • Robinhood Token', underlying_symbol: 'CRWD',
    asset_class: 'STOCK_TOKEN', decimals: 18, isin: 'US22788C1053',
    status: 'ASSET_STATUS_ACTIVE', tradable: 1, multiplier: CRWD.multiplier,
    onchain_multiplier: CRWD.multiplier, pending_multiplier: null, pending_effective_at: null,
    verified_onchain: 1, eligibility: 'SHADOW_ONLY', eligibility_reason: 'test',
    first_seen_at: now, last_verified_at: now, updated_at: now,
    ...over,
  };
  db.prepare(
    `INSERT OR REPLACE INTO rh_assets
       (symbol, chain_id, contract_address, name, underlying_symbol, asset_class, decimals, isin,
        status, tradable, multiplier, onchain_multiplier, pending_multiplier, pending_effective_at,
        verified_onchain, eligibility, eligibility_reason, first_seen_at, last_verified_at, updated_at)
     VALUES (@symbol, @chain_id, @contract_address, @name, @underlying_symbol, @asset_class, @decimals,
             @isin, @status, @tradable, @multiplier, @onchain_multiplier, @pending_multiplier,
             @pending_effective_at, @verified_onchain, @eligibility, @eligibility_reason,
             @first_seen_at, @last_verified_at, @updated_at)`,
  ).run(row);
  // a fresh registry run, so registry_fresh passes
  db.prepare(`INSERT INTO rh_registry_runs (ts, ok, assets_seen, assets_verified, assets_rejected) VALUES (?, 1, 1, 1, 0)`)
    .run(Date.now());
}

describe('chain facts', () => {
  it('names the two chains explicitly and never reuses another network id', () => {
    expect(ROBINHOOD_MAINNET_CHAIN_ID).toBe(4663);
    expect(ROBINHOOD_TESTNET_CHAIN_ID).toBe(46630);
    // Base's 8453 must not appear anywhere in the Robinhood config
    expect(ROBINHOOD_MAINNET_CHAIN_ID).not.toBe(8453);
  });

  it('USDG settles with SIX decimals, not eighteen', () => {
    // verified onchain: decimals() on 0x5fc5...d168 returns 6.
    // Assuming 18 here multiplies every settlement amount by 1e12.
    expect(USDG.decimals).toBe(6);
    expect(WETH_ROBINHOOD.decimals).toBe(18);
    expect(USDG.decimals).not.toBe(WETH_ROBINHOOD.decimals);
  });

  it('records the issuer, because a Stock Token is a claim on it', () => {
    expect(STOCK_TOKEN_ISSUER.name).toMatch(/Jersey/);
    expect(STOCK_TOKEN_ISSUER.instrumentType).toBe('tokenized debt security');
  });
});

describe('multiplier arithmetic', () => {
  it('parses and formats 18-decimal fixed point exactly', () => {
    expect(parseMultiplier('1.000000000000000000')).toBe(MULTIPLIER_SCALE);
    expect(parseMultiplier('4.000000000000000000')).toBe(4n * MULTIPLIER_SCALE);
    expect(parseMultiplier('1.000566080061092436')).toBe(1000566080061092436n);
    expect(formatMultiplier(1000566080061092436n)).toBe('1.000566080061092436');
    expect(formatMultiplier(parseMultiplier('4'))).toBe('4.000000000000000000');
  });

  it('treats a missing multiplier as 1.0 but refuses a malformed one', () => {
    expect(parseMultiplier('')).toBe(MULTIPLIER_SCALE);
    expect(parseMultiplier(null)).toBe(MULTIPLIER_SCALE);
    expect(() => parseMultiplier('four')).toThrow(/unparseable/);
    expect(() => parseMultiplier('-1.0')).toThrow(/unparseable/);
  });

  it('THE CRWD CASE: a 4:1 split makes the token worth 4x the share price', () => {
    const multiplier = M(CRWD.multiplier);
    const tokenPrice = normalizeStockTokenPrice(CRWD.underlyingBid, multiplier);
    expect(tokenPrice).toBeCloseTo(872.12, 2);
  });

  it('converts a token balance to underlying exposure exactly, in integers', () => {
    const oneToken = 10n ** 18n;
    expect(normalizeUnderlyingExposure(oneToken, M('4'))).toBe(4n * oneToken);
    expect(normalizeUnderlyingExposure(oneToken, M('1'))).toBe(oneToken);
    // and back again, losslessly at this scale
    expect(tokenAmountForExposure(4n * oneToken, M('4'))).toBe(oneToken);
  });

  it('refuses a non-positive multiplier rather than dividing by it', () => {
    expect(() => normalizeStockTokenPrice(100, 0n)).toThrow(/positive/);
    expect(() => normalizeUnderlyingExposure(1n, 0n)).toThrow(/positive/);
    expect(() => normalizeUnderlyingExposure(1n, -1n)).toThrow(/positive/);
  });

  it('a pending change is signalled by INEQUALITY, not by nullness', () => {
    const now = Date.now();
    const soon = Math.floor(now / 1000) + 3600;
    // the live case: nothing scheduled means next === current
    expect(pendingMultiplier(M('4'), M('4'), 1782999000, now).pending).toBe(false);
    // a genuine upcoming change
    const p = pendingMultiplier(M('1'), M('2'), soon, now);
    expect(p.pending).toBe(true);
    expect(p.overdue).toBe(false);
  });

  it('a change whose effective time has passed but we have not re-verified is OVERDUE', () => {
    const now = Date.now();
    const past = Math.floor(now / 1000) - 3600;
    const p = pendingMultiplier(M('1'), M('2'), past, now);
    expect(p.pending).toBe(false);
    expect(p.overdue).toBe(true);
  });
});

describe('historical multipliers', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('returns the multiplier in force at a past instant, not today\'s', () => {
    recordMultiplier(db, 'CRWD', CRWD.address, M('1'), 1_750_000_000, 'test');
    recordMultiplier(db, 'CRWD', CRWD.address, M('4'), 1_782_999_000, 'test');

    const beforeSplit = 1_760_000_000_000; // ms
    const afterSplit = 1_790_000_000_000;
    expect(formatMultiplier(multiplierAt(db, 'CRWD', beforeSplit))).toBe('1.000000000000000000');
    expect(formatMultiplier(multiplierAt(db, 'CRWD', afterSplit))).toBe('4.000000000000000000');
  });

  it('REFUSES rather than defaulting to 1.0 when history is missing', () => {
    // silently defaulting is how a split becomes a backtested 300% gain
    expect(() => multiplierAt(db, 'NVDA', Date.now())).toThrow(/no multiplier recorded/);
  });
});

describe('dislocation measurement', () => {
  it('the multiplier is what separates a real edge from a fantasy one', () => {
    // the token trades at fair value given the 4x multiplier
    const d = measureDislocation({
      underlyingPrice: CRWD.underlyingBid,
      multiplier: M('4'),
      executableBuy: 872.5,
      executableSell: 871.7,
    });
    expect(Math.abs(d.rawDislocationBps)).toBeLessThan(10);
    expect(d.direction).toBe('flat');

    // and the number a naive engine would have seen instead
    expect(d.naiveUnadjustedBps).toBeGreaterThan(29_000); // ~+300%
  });

  it('finds a genuine premium once the multiplier is applied', () => {
    const d = measureDislocation({
      underlyingPrice: 100, multiplier: M('1'), executableBuy: 100.5, executableSell: 100.4,
    });
    expect(d.direction).toBe('premium');
    expect(d.rawDislocationBps).toBeCloseTo(45, 0);
  });

  it('the small live multipliers are the dangerous ones', () => {
    // AAPL sits at 1.000566 — an 5.7bps error, right inside the range a
    // dislocation strategy trades, and invisible unless you look for it
    const d = measureDislocation({
      underlyingPrice: 318.56, multiplier: M('1.000566080061092436'),
      executableBuy: 318.74, executableSell: 318.72,
    });
    expect(Math.abs(d.naiveUnadjustedBps - d.rawDislocationBps)).toBeCloseTo(5.66, 1);
  });
});

describe('corporate actions', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('a cash dividend does not stop trading; a split does', () => {
    expect(blocksTrading('CORPORATE_ACTION_TYPE_CASH_DIVIDEND', 'CORPORATE_ACTION_STATUS_IN_PROGRESS')).toBe(false);
    expect(blocksTrading('CORPORATE_ACTION_TYPE_STOCK_SPLIT', 'CORPORATE_ACTION_STATUS_IN_PROGRESS')).toBe(true);
    expect(blocksTrading('CORPORATE_ACTION_TYPE_MERGER', 'CORPORATE_ACTION_STATUS_PENDING')).toBe(true);
  });

  it('a completed action stops blocking', () => {
    expect(blocksTrading('CORPORATE_ACTION_TYPE_STOCK_SPLIT', 'CORPORATE_ACTION_STATUS_COMPLETED')).toBe(false);
  });

  it('an UNKNOWN action type blocks — fail closed on a type we have never seen', () => {
    expect(blocksTrading('SOMETHING_ENTIRELY_NEW', 'CORPORATE_ACTION_STATUS_IN_PROGRESS')).toBe(true);
  });

  it('ingests actions and reports which symbols are standing down', async () => {
    const payload = {
      corpActions: [
        {
          id: 'a1', type: 'CORPORATE_ACTION_TYPE_STOCK_SPLIT',
          status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS',
          processDate: { year: 2026, month: 9, day: 15 }, tokenSymbol: 'NVDA',
          deployments: [{ contractAddress: '0xabc', chainId: 4663 }], details: { ratio: '4:1' },
        },
        {
          id: 'a2', type: 'CORPORATE_ACTION_TYPE_CASH_DIVIDEND',
          status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS',
          processDate: { year: 2026, month: 9, day: 29 }, tokenSymbol: 'GLW',
          deployments: [{ contractAddress: '0xdef', chainId: 4663 }], details: { rate: '0.28' },
        },
      ],
    };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const report = await refreshCorporateActions(db, { fetchImpl: fakeFetch });

    expect(report.ok).toBe(true);
    expect(report.seen).toBe(2);
    expect(report.blocking).toBe(1);
    expect(report.newlyBlocking).toEqual(['NVDA:CORPORATE_ACTION_TYPE_STOCK_SPLIT']);

    expect(corporateActionState(db, 'NVDA').blocked).toBe(true);
    expect(corporateActionState(db, 'NVDA').reason).toMatch(/STOCK_SPLIT/);
    expect(corporateActionState(db, 'GLW').blocked).toBe(false);
    expect(corporateActionState(db, 'AAPL').blocked).toBe(false);
  });

  it('a pause is written to the audit trail', async () => {
    const payload = { corpActions: [{
      id: 'a1', type: 'CORPORATE_ACTION_TYPE_REVERSE_SPLIT',
      status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS', tokenSymbol: 'XYZ', deployments: [],
    }] };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    await refreshCorporateActions(db, { fetchImpl: fakeFetch });
    const audit = db.prepare(`SELECT * FROM audit_log WHERE action = 'instruments_paused'`).all() as any[];
    expect(audit).toHaveLength(1);
  });

  it('an unreachable API does not clear existing blocks', async () => {
    const ok = { corpActions: [{ id: 'a1', type: 'CORPORATE_ACTION_TYPE_MERGER', status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS', tokenSymbol: 'AAA', deployments: [] }] };
    await refreshCorporateActions(db, { fetchImpl: (async () => new Response(JSON.stringify(ok), { status: 200 })) as any });
    expect(corporateActionState(db, 'AAA').blocked).toBe(true);

    const failing = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const report = await refreshCorporateActions(db, { fetchImpl: failing });
    expect(report.ok).toBe(false);
    expect(corporateActionState(db, 'AAA').blocked).toBe(true);
  });
});

describe('reference prices', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  const quote = (over: Record<string, unknown> = {}) => ({
    quotes: [{
      tokenSymbol: 'AAPL', bid: '318.56', ask: '318.73', currency: 'USD',
      isTradingHalt: false, generatedAt: new Date().toISOString(),
      dailyTradingVolume: '529218', dailyHigh: '322', dailyLow: '318.5', ...over,
    }],
  });

  it('ages a quote against the API timestamp, not our fetch time', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const fakeFetch = (async () => new Response(JSON.stringify(quote({ generatedAt: old })), { status: 200 })) as any;
    const q = await fetchReferenceQuote(db, 'AAPL', { fetchImpl: fakeFetch });
    expect(q).not.toBeNull();
    expect(q!.ageMs).toBeGreaterThan(110_000);
    expect(q!.stale).toBe(true);
  });

  it('rejects a stale, halted, or absent quote', () => {
    expect(referencePriceGate(null).usable).toBe(false);
    const fresh = {
      symbol: 'AAPL', bid: 100, ask: 100.1, mid: 100.05, currency: 'USD',
      isTradingHalt: false, generatedAt: Date.now(), ageMs: 500, stale: false,
    };
    expect(referencePriceGate(fresh).usable).toBe(true);
    expect(referencePriceGate({ ...fresh, stale: true, ageMs: 71_000 }).reason).toMatch(/71s old/);
    expect(referencePriceGate({ ...fresh, isTradingHalt: true }).reason).toMatch(/halted/);
    expect(referencePriceGate({ ...fresh, ask: 120, mid: 110 }).reason).toMatch(/too wide/);
  });

  it('treats a future-dated quote as untrustworthy too', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const fakeFetch = (async () => new Response(JSON.stringify(quote({ generatedAt: future })), { status: 200 })) as any;
    const q = await fetchReferenceQuote(db, 'AAPL', { fetchImpl: fakeFetch });
    expect(q!.stale).toBe(true);
  });

  it('refuses a nonsensical quote outright', async () => {
    for (const bad of [{ bid: '0' }, { ask: 'abc' }, { bid: '200', ask: '100' }]) {
      const fakeFetch = (async () => new Response(JSON.stringify(quote(bad)), { status: 200 })) as any;
      expect(await fetchReferenceQuote(db, 'AAPL', { fetchImpl: fakeFetch })).toBeNull();
    }
  });

  it('caches, and reports the cached quote with its real age', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify(quote()), { status: 200 })) as any;
    await fetchReferenceQuote(db, 'AAPL', { fetchImpl: fakeFetch });
    const cached = lastReferenceQuote(db, 'AAPL', { now: Date.now() + 90_000 });
    expect(cached).not.toBeNull();
    expect(cached!.stale).toBe(true);
  });
});

describe('asset classification', () => {
  it('separates stock tokens, ETFs, stablecoins and crypto', () => {
    expect(classifyAsset('AAPL', 'Apple • Robinhood Token')).toBe('STOCK_TOKEN');
    expect(classifyAsset('SPY', 'SPDR S&P 500 • Robinhood Token')).toBe('ETF_TOKEN');
    expect(classifyAsset('SGOV', 'iShares 0-3 Month Treasury Bond • Robinhood Token')).toBe('ETF_TOKEN');
    expect(classifyAsset('USDG', 'Global Dollar')).toBe('STABLECOIN');
    expect(classifyAsset('WETH', 'Wrapped Ether')).toBe('CRYPTO');
  });
});

describe('the registry', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('a registry nobody has refreshed reports STALE, not fresh', () => {
    const status = registryStatus(db);
    expect(status.stale).toBe(true);
    expect(status.lastRunAt).toBeNull();
  });

  it('keeps the last snapshot when the API is unreachable, and records the failure', async () => {
    seedAsset(db);
    const failing = (async () => { throw new Error('DNS failure'); }) as unknown as typeof fetch;
    const report = await refreshRegistry(db, { fetchImpl: failing });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/DNS failure/);
    // the asset is still there — an outage must not empty the registry
    expect(getAsset(db, 'CRWD')).not.toBeNull();
    const run = db.prepare(`SELECT * FROM rh_registry_runs ORDER BY id DESC LIMIT 1`).get() as any;
    expect(run.ok).toBe(0);
    expect(run.error).toMatch(/DNS failure/);
  });

  it('seeds the two documented core tokens with their real decimals', () => {
    seedCoreTokens(db);
    expect(getAsset(db, 'USDG')!.decimals).toBe(6);
    expect(getAsset(db, 'WETH')!.decimals).toBe(18);
  });
});

describe('the instrument resolver', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('resolves a verified, clear asset to a signable instrument', () => {
    seedAsset(db);
    const r = resolveRobinhoodInstrument(db, 'CRWD', 'SHADOW_ONLY');
    expect(r.resolved).toBe(true);
    expect(r.instrument!.contractAddress).toBe(CRWD.address);
    expect(r.instrument!.chainId).toBe(4663);
    expect(r.instrument!.decimals).toBe(18);
    // and the quote leg carries USDG's OWN decimals, not the token's
    expect(r.instrument!.quoteDecimals).toBe(6);
    expect(r.instrument!.multiplier).toBe(4n * MULTIPLIER_SCALE);
  });

  it('a strategy cannot smuggle in a contract address', () => {
    seedAsset(db);
    const r = resolveRobinhoodInstrument(db, '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931');
    expect(r.resolved).toBe(false);
    expect(r.reason).toMatch(/plausible ticker/);
  });

  it('refuses an unregistered symbol', () => {
    seedAsset(db);
    expect(resolveRobinhoodInstrument(db, 'TSLA').resolved).toBe(false);
  });

  it('refuses an asset never verified against the chain', () => {
    seedAsset(db, { verified_onchain: 0 });
    const r = resolveRobinhoodInstrument(db, 'CRWD', 'SHADOW_ONLY');
    expect(r.resolved).toBe(false);
    expect(r.checks.find((c) => c.name === 'verified_onchain')!.pass).toBe(false);
  });

  it('refuses while a corporate action is outstanding', async () => {
    seedAsset(db);
    const payload = { corpActions: [{
      id: 'x', type: 'CORPORATE_ACTION_TYPE_STOCK_SPLIT',
      status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS', tokenSymbol: 'CRWD', deployments: [],
    }] };
    await refreshCorporateActions(db, { fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as any });
    const r = resolveRobinhoodInstrument(db, 'CRWD', 'SHADOW_ONLY');
    expect(r.resolved).toBe(false);
    expect(r.checks.find((c) => c.name === 'no_corporate_action')!.pass).toBe(false);
  });

  it('refuses while a multiplier change is scheduled', () => {
    seedAsset(db, {
      pending_multiplier: '8.000000000000000000',
      pending_effective_at: Math.floor(Date.now() / 1000) + 7200,
    });
    const r = resolveRobinhoodInstrument(db, 'CRWD', 'SHADOW_ONLY');
    expect(r.resolved).toBe(false);
    expect(r.checks.find((c) => c.name === 'no_pending_multiplier')!.pass).toBe(false);
  });

  it('refuses on a stale registry however good the asset row looks', () => {
    seedAsset(db);
    db.prepare(`UPDATE rh_registry_runs SET ts = ?`).run(Date.now() - 48 * 3_600_000);
    const r = resolveRobinhoodInstrument(db, 'CRWD', 'SHADOW_ONLY');
    expect(r.resolved).toBe(false);
    expect(r.checks.find((c) => c.name === 'registry_fresh')!.pass).toBe(false);
  });

  it('eligibility rises with the mode: shadow-eligible is not canary-eligible', () => {
    seedAsset(db);
    expect(resolveRobinhoodInstrument(db, 'CRWD', 'RESEARCH_ONLY').resolved).toBe(true);
    expect(resolveRobinhoodInstrument(db, 'CRWD', 'SHADOW_ONLY').resolved).toBe(true);
    expect(resolveRobinhoodInstrument(db, 'CRWD', 'CANARY_ALLOWED').resolved).toBe(false);
    expect(resolveRobinhoodInstrument(db, 'CRWD', 'LIVE_ALLOWED').resolved).toBe(false);
  });

  it('the eligibility service cannot promote to canary or live on its own', () => {
    seedAsset(db);
    const decision = evaluateEligibility(db, 'CRWD');
    expect(decision.state).toBe('SHADOW_ONLY');
    expect(atLeast(decision.state, 'CANARY_ALLOWED')).toBe(false);
  });

  it('an unverified asset is BLOCKED, not merely research-only', () => {
    seedAsset(db, { verified_onchain: 0 });
    expect(evaluateEligibility(db, 'CRWD').state).toBe('BLOCKED');
  });
});
