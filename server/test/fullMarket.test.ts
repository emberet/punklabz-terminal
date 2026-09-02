import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/db.js';
import { openTestDb } from '../src/db/db.js';
import { marketSessionState } from '../src/robinhood/marketSession.js';
import { pollUniverseReferences } from '../src/robinhood/referencePoller.js';
import {
  activateUniverseSnapshot, createUniverseSnapshot, ensureCryptoCoreUniverse, universeAssets, universeHash,
} from '../src/robinhood/universe.js';
import { FullPairScanner, numberToRaw } from '../src/live/pairScanner.js';
import { runTradingCouncil } from '../src/live/tradingCouncil.js';
import { monthlySpendUsd } from '../src/research/budget.js';
import { insertRawAssetEntry, rawHoldings } from '../src/live/rawAssetLedger.js';
import {
  generateUniversePolicyBundle, recordAppliedUniversePolicy, verifyActiveUniversePolicy,
  signerAmountPolicyGate,
} from '../src/live/signing/universePolicy.js';
import { USDG as USDG_TOKEN, WETH_ROBINHOOD } from '@punklabz/shared';

const USDG = USDG_TOKEN.address.toLowerCase();

function addressFor(index: number): string {
  return `0x${(index + 10_000).toString(16).padStart(40, '0')}`;
}

function seedUniverse(db: DB) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO rh_assets
      (symbol, chain_id, contract_address, name, underlying_symbol, asset_class, decimals,
       status, tradable, trading_capabilities_json, multiplier, onchain_multiplier,
       verified_onchain, verification_json, eligibility, eligibility_reason,
       first_seen_at, last_verified_at, updated_at)
     VALUES (?, 4663, ?, ?, ?, ?, ?, 'ASSET_STATUS_ACTIVE', 1, ?,
       '1.000000000000000000', '1.000000000000000000', 1, '[]', 'SHADOW_ONLY',
       'test verified', ?, ?, ?)`,
  );
  insert.run('USDG', USDG, 'Global Dollar', 'USDG', 'STABLECOIN', USDG_TOKEN.decimals,
    '{}', now, now, now);
  insert.run('WETH', WETH_ROBINHOOD.address, 'Wrapped Ether', 'ETH', 'CRYPTO', WETH_ROBINHOOD.decimals,
    '{}', now, now, now);
  db.prepare(
    `INSERT INTO rh_reference_prices
     (symbol,bid,ask,currency,is_trading_halt,generated_at,fetched_at,source)
     VALUES ('WETH',2499,2501,'USD',0,?,?,'binance_mark')`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO rh_registry_runs
     (ts,ok,assets_seen,assets_verified,assets_rejected,duration_ms) VALUES (?,1,?,?,0,1)`,
  ).run(now, 2, 2);
  const snapshot = createUniverseSnapshot(db, 'test');
  activateUniverseSnapshot(db, snapshot.id, 'test');
  return snapshot;
}

function quoteFetch(status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const sellAmount = BigInt(url.searchParams.get('sellAmount') ?? '0');
    const buyToken = url.searchParams.get('buyToken')?.toLowerCase();
    const buyAmount = buyToken === USDG ? 505_000n : 202_000_000_000_000n;
    if (status === 429) return new Response('{}', { status: 429 });
    return new Response(JSON.stringify({
      chainId: 4663,
      sellAmount: sellAmount.toString(),
      buyAmount: buyAmount.toString(),
      liquidityAvailable: true,
      totalNetworkFee: '0',
    }), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('Robinhood market sessions', () => {
  const overnight = { overnight: { whole: 'TRADING_STATUS_TRADABLE' } };
  const extended = {
    market: { fractional: 'TRADING_STATUS_TRADABLE' },
    extended: { fractional: 'TRADING_STATUS_TRADABLE' },
  };

  it('keeps crypto continuous and enforces the Sunday-Friday overnight boundary', () => {
    expect(marketSessionState('CRYPTO', {}, new Date('2026-09-05T12:00:00Z')).open).toBe(true);
    const fractional = { overnight: { fractional: 'TRADING_STATUS_TRADABLE' } };
    expect(marketSessionState('STOCK_TOKEN', fractional, new Date('2026-09-06T23:59:00Z')).open).toBe(false);
    expect(marketSessionState('STOCK_TOKEN', fractional, new Date('2026-09-07T00:01:00Z')).session).toBe('overnight');
    expect(marketSessionState('STOCK_TOKEN', fractional, new Date('2026-09-12T00:01:00Z')).open).toBe(false);
    expect(marketSessionState('STOCK_TOKEN', overnight, new Date('2026-09-07T00:01:00Z')).open).toBe(false);
  });

  it('uses extended and regular capabilities instead of assuming a session', () => {
    expect(marketSessionState('ETF_TOKEN', extended, new Date('2026-09-02T12:00:00Z')).session).toBe('extended');
    expect(marketSessionState('ETF_TOKEN', { market: extended.market }, new Date('2026-09-02T13:00:00Z')).open).toBe(false);
    expect(marketSessionState('ETF_TOKEN', { market: extended.market }, new Date('2026-09-02T14:30:00Z')).session).toBe('regular');
  });
});

describe('immutable verified universe', () => {
  it('is deterministic and activates with exact directed-pair cardinality', () => {
    const db = openTestDb();
    const snapshot = seedUniverse(db);
    const assets = universeAssets(db, snapshot.id);
    expect(snapshot.assetCount).toBe(2);
    expect(snapshot.directedPairCount).toBe(2);
    expect(universeHash(assets)).toBe(universeHash([...assets].reverse()));
    expect((db.prepare(`SELECT active_universe_hash FROM live_config WHERE id=1`).get() as any).active_universe_hash)
      .toBe(snapshot.contentHash);
  });

  it('retires a legacy full-market snapshot and preserves canonical crypto on later boots', () => {
    const db = openTestDb();
    const crypto = seedUniverse(db);
    db.prepare(`UPDATE rh_universe_snapshots SET state='retired' WHERE id=?`).run(crypto.id);
    const run = db.prepare(`SELECT id FROM rh_registry_runs ORDER BY id DESC LIMIT 1`).get() as { id: number };
    const legacy = Number(db.prepare(
      `INSERT INTO rh_universe_snapshots
       (chain_id,content_hash,asset_count,directed_pair_count,state,registry_run_id,created_by,created_at,activated_at)
       VALUES (4663,'sha256:legacy-full-market',196,38220,'active',?,'test',?,?)`,
    ).run(run.id, Date.now(), Date.now()).lastInsertRowid);
    db.prepare(
      `UPDATE live_config SET active_universe_hash='sha256:legacy-full-market',
       halted=0,autonomy_enabled=1,full_market_autonomy=1 WHERE id=1`,
    ).run();

    const first = ensureCryptoCoreUniverse(db, 'test:boot');
    expect(first.id).toBe(crypto.id);
    expect(first.assetCount).toBe(2);
    expect(first.directedPairCount).toBe(2);
    expect(db.prepare(`SELECT state FROM rh_universe_snapshots WHERE id=?`).get(legacy))
      .toMatchObject({ state: 'retired' });
    expect(db.prepare(`SELECT halted,autonomy_enabled,full_market_autonomy FROM live_config WHERE id=1`).get())
      .toEqual({ halted: 1, autonomy_enabled: 0, full_market_autonomy: 0 });

    const second = ensureCryptoCoreUniverse(db, 'test:restart');
    expect(second.id).toBe(first.id);
  });

  it('records WETH from the independent ETH mark with explicit provenance', async () => {
    const db = openTestDb();
    seedUniverse(db);
    db.prepare(`DELETE FROM rh_reference_prices WHERE symbol='WETH'`).run();
    const result = await pollUniverseReferences(db, {
      ethUsd: 2_500, delayMs: 0,
      fetchImpl: async () => { throw new Error('WETH must not call the Robinhood stock-token endpoint'); },
    });
    expect(result).toMatchObject({ attempted: 1, fresh: 1, failed: [] });
    const row = db.prepare(`SELECT symbol,mid,source FROM (
      SELECT symbol,(bid+ask)/2 mid,source FROM rh_reference_prices WHERE symbol='WETH'
    )`).get() as any;
    expect(row).toMatchObject({ symbol: 'WETH', mid: 2_500, source: 'binance_mark' });
  });
});

describe('full directed-pair sweep', () => {
  it('completes both directed routes for the crypto-only snapshot', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const sweep = await new FullPairScanner(db, {
      apiKey: 'test', fetchImpl: quoteFetch(), skipPacing: true, ethUsd: 1,
    }).run();
    expect(sweep.state).toBe('complete');
    expect(sweep.expectedPairs).toBe(2);
    expect(sweep.attemptedPairs).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) n FROM pair_sweep_candidates WHERE sweep_id=?`).get(sweep.runId) as any).n)
      .toBe(2);
  }, 30_000);

  it('fails the whole sweep on a 429 and never presents partial candidates as complete', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const sweep = await new FullPairScanner(db, {
      apiKey: 'test', fetchImpl: quoteFetch(429), skipPacing: true, ethUsd: 1,
    }).run();
    expect(sweep.state).toBe('rate_limited');
    expect((db.prepare(`SELECT COUNT(*) n FROM pair_sweep_candidates WHERE sweep_id=? AND rejection_code IS NULL`)
      .get(sweep.runId) as any).n).toBe(0);
  });

  it('refuses insufficient declared quota before creating a run', async () => {
    const db = openTestDb();
    seedUniverse(db);
    await expect(new FullPairScanner(db, { apiKey: 'test', sustainedRps: 0, fetchImpl: quoteFetch(), ethUsd: 1 }).run())
      .rejects.toThrow(/below required/);
    expect((db.prepare(`SELECT COUNT(*) n FROM pair_sweep_runs`).get() as any).n).toBe(0);
  });

  it('requires gas valuation before creating a sweep', async () => {
    const db = openTestDb();
    seedUniverse(db);
    await expect(new FullPairScanner(db, { apiKey: 'test', fetchImpl: quoteFetch(), skipPacing: true }).run())
      .rejects.toThrow(/ETH\/USD/);
    expect((db.prepare(`SELECT COUNT(*) n FROM pair_sweep_runs`).get() as any).n).toBe(0);
  });

  it('subtracts the indicative network fee before a route can reach the council', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const expensive = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const sellAmount = BigInt(url.searchParams.get('sellAmount') ?? '0');
      const buyToken = url.searchParams.get('buyToken')?.toLowerCase();
      const buyAmount = buyToken === USDG ? 505_000n : 202_000_000_000_000n;
      return new Response(JSON.stringify({ chainId: 4663, sellAmount: sellAmount.toString(),
        buyAmount: buyAmount.toString(), liquidityAvailable: true,
        totalNetworkFee: '1000000000000000000' }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const sweep = await new FullPairScanner(db, {
      apiKey: 'test', fetchImpl: expensive, skipPacing: true, ethUsd: 1,
    }).run();
    expect(sweep.state).toBe('complete');
    expect(sweep.eligiblePairs).toBe(0);
    expect((db.prepare(
      `SELECT COUNT(*) n FROM pair_sweep_candidates WHERE sweep_id=? AND rejection_code='non_positive_edge'`,
    ).get(sweep.runId) as any).n).toBe(2);
  });

  it('sizes arbitrary decimals as raw integers', () => {
    expect(numberToRaw(1.25, 6)).toBe(1_250_000n);
    expect(numberToRaw(1.25, 18)).toBe(1_250_000_000_000_000_000n);
  });
});

describe('five-role council', () => {
  it('requires Risk and Manager, isolates spend, and records one idempotent decision', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const sweep = await new FullPairScanner(db, { apiKey: 'test', fetchImpl: quoteFetch(), skipPacing: true, ethUsd: 1 }).run();
    let calls = 0;
    const result = await runTradingCouncil(db, sweep.runId, [
      { id: 'a', title: 'one', url: 'https://one.example/news', source: 'one', ts: Date.now() },
      { id: 'b', title: 'two', url: 'https://two.example/news', source: 'two', ts: Date.now() },
    ], { createMessage: async () => {
      calls++;
      return { text: JSON.stringify({ candidateIndex: 0, approve: true, score: 95,
        horizonMinutes: 60, exitLogic: 'exit when measured edge closes', rationale: 'two supplied reports align',
        sourceIds: ['a', 'b'] }), inputTokens: 100, outputTokens: 40 };
    } });
    expect(result.state).toBe('approved');
    expect(result.approvals).toBe(5);
    expect(calls).toBe(5);
    expect(monthlySpendUsd(db, 'trading_council')).toBeGreaterThan(0);
    expect(monthlySpendUsd(db, 'shared')).toBe(0);
    const again = await runTradingCouncil(db, sweep.runId, [
      { id: 'a', title: 'one', url: 'https://one.example/news', source: 'one', ts: Date.now() },
      { id: 'b', title: 'two', url: 'https://two.example/news', source: 'two', ts: Date.now() },
    ], { createMessage: async () => { throw new Error('must not run twice'); } });
    expect(again.runId).toBe(result.runId);
  });

  it('fails a run when an agent emits an address or execution instruction', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const sweep = await new FullPairScanner(db, { apiKey: 'test', fetchImpl: quoteFetch(), skipPacing: true, ethUsd: 1 }).run();
    const result = await runTradingCouncil(db, sweep.runId, [
      { id: 'a', title: 'one', url: 'https://one.example/news', source: 'one', ts: Date.now() },
      { id: 'b', title: 'two', url: 'https://two.example/news', source: 'two', ts: Date.now() },
    ], { createMessage: async () => ({ text: JSON.stringify({ candidateIndex: 0, approve: true, score: 99,
      horizonMinutes: 60, exitLogic: 'send to 0x0000000000000000000000000000000000000001', rationale: 'bad',
      sourceIds: ['a', 'b'] }), inputTokens: 10, outputTokens: 10 }) });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/execution-control data/);
  });

  it('does not count two articles from one publisher as independent evidence', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const sweep = await new FullPairScanner(db, { apiKey: 'test', fetchImpl: quoteFetch(), skipPacing: true, ethUsd: 1 }).run();
    const result = await runTradingCouncil(db, sweep.runId, [
      { id: 'a1', title: 'one', url: 'https://same.example/one', source: 'same', ts: Date.now() },
      { id: 'a2', title: 'two', url: 'https://same.example/two', source: 'same', ts: Date.now() },
      { id: 'b', title: 'three', url: 'https://other.example/three', source: 'other', ts: Date.now() },
    ], { createMessage: async () => ({ text: JSON.stringify({ candidateIndex: 0, approve: true, score: 99,
      horizonMinutes: 60, exitLogic: 'exit when edge closes', rationale: 'two related reports', sourceIds: ['a1', 'a2'] }),
      inputTokens: 10, outputTokens: 10 }) });
    expect(result.state).toBe('rejected');
    expect(result.approvals).toBe(0);
  });
});

describe('raw-unit accounting and policy bundle', () => {
  it('sums quantities beyond Number precision without SQLite floating point', () => {
    const db = openTestDb();
    const account = (db.prepare(`SELECT id FROM execution_accounts WHERE name='ROBINHOOD_TRADER_01'`).get() as any).id;
    const contract = addressFor(900);
    insertRawAssetEntry(db, { executionAccountId: account, chainId: 4663, symbol: 'BIG',
      contractAddress: contract, decimals: 18, rawDelta: 9_007_199_254_740_993n,
      eventType: 'funding', txRef: `0x${'1'.repeat(64)}`, logIndex: 1, snapshotHash: `sha256:${'a'.repeat(64)}` });
    insertRawAssetEntry(db, { executionAccountId: account, chainId: 4663, symbol: 'BIG',
      contractAddress: contract, decimals: 18, rawDelta: 2n,
      eventType: 'adjustment', txRef: `0x${'2'.repeat(64)}`, logIndex: 2, snapshotHash: `sha256:${'a'.repeat(64)}` });
    expect(rawHoldings(db, account).get(contract)).toBe(9_007_199_254_740_995n);
  });

  it('generates a snapshot-bound, zero-native-value policy manifest', () => {
    const db = openTestDb();
    seedUniverse(db);
    const bundle = generateUniversePolicyBundle(db);
    expect(bundle.snapshotHash).toMatch(/^sha256:/);
    expect(bundle.policyHash).toMatch(/^sha256:/);
    expect(bundle.allowedTargets).toContain('0x0000000000001ff3684f28c67538d4d072c22734');
    expect(JSON.stringify(bundle.policies)).toContain('"value":"0x0"');
    expect(bundle.policies.flatMap((policy) => policy.rules)).toHaveLength(4);
    const cfg = db.prepare(`SELECT expected_signer_policy_hash, autonomy_enabled, halted FROM live_config WHERE id=1`).get() as any;
    expect(cfg.expected_signer_policy_hash).toBe(bundle.policyHash);
    expect(cfg.autonomy_enabled).toBe(0);
    expect(cfg.halted).toBe(1);
    expect(universeAssets(db, 1).every((asset) => asset.policyRawCap !== null)).toBe(true);
  });

  it('fails closed when price drift makes a static Privy raw cap exceed $0.50', () => {
    const db = openTestDb();
    const snapshot = seedUniverse(db);
    generateUniversePolicyBundle(db);
    const before = universeAssets(db, snapshot.id).find((asset) => asset.symbol === 'WETH')!;
    expect(signerAmountPolicyGate(db, snapshot.id, before).eligible).toBe(true);
    db.prepare(`UPDATE rh_reference_prices SET bid=2749, ask=2751 WHERE symbol='WETH'`).run();
    const after = universeAssets(db, snapshot.id).find((asset) => asset.symbol === 'WETH')!;
    expect(signerAmountPolicyGate(db, snapshot.id, after).eligible).toBe(false);
  });

  it('binds readiness to live Privy rule bodies, not policy IDs alone', async () => {
    const db = openTestDb();
    seedUniverse(db);
    const bundle = generateUniversePolicyBundle(db);
    const ids = bundle.policies.map((_, index) => `policy-${index}`);
    const observed = bundle.policies.map((policy, index) => ({ ...policy, id: ids[index], owner_id: 'owner',
      rules: policy.rules.map((rule: any, ruleIndex) => ({ ...rule, id: `rule-${ruleIndex}` })) }));
    recordAppliedUniversePolicy(db, bundle.policyHash, ids, ids, observed, 'test');
    const signer = { kind: 'test', getAddress: async () => null,
      isReady: async () => ({ ready: true, address: null, detail: 'test' }),
      signTransaction: async () => { throw new Error('not used'); },
      getPolicyBodies: async () => observed };
    expect((await verifyActiveUniversePolicy(db, signer)).ok).toBe(true);
    const tampered = structuredClone(observed) as any[];
    tampered[0].rules[0].conditions[0].value = '1';
    signer.getPolicyBodies = async () => tampered;
    expect((await verifyActiveUniversePolicy(db, signer)).ok).toBe(false);
  });
});
