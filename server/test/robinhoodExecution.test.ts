import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD } from '@punklabz/shared';
import { ROBINHOOD_VENUE, SETTLEMENT, findInstrument } from '../src/live/instruments.js';
import {
  ZEROX_ALLOWANCE_HOLDER, mappedSymbols, resolveLiveInstrument, validateMappings,
} from '../src/live/instrumentResolver.js';
import { verifyQuote, type ZeroXQuote } from '../src/live/adapters/zeroXRobinhood.js';
import { buildAdapters, NotConfiguredAdapter } from '../src/live/adapters.js';
import { ExecutionRouter } from '../src/live/executionRouter.js';
import { runPreflight } from '../src/live/preflight.js';
import { NoSigner } from '../src/live/signing/signer.js';
import { PrivySigner } from '../src/live/signing/privySigner.js';

const CHAIN = ROBINHOOD_MAINNET_CHAIN_ID;
const TAKER = '0xD5788b6694a05366FaaeEfEff35c7a5913D02Ff9';

/** a quote shaped exactly like a good one, so each test can spoil ONE field */
const goodQuote = (over: Partial<ZeroXQuote> = {}): ZeroXQuote => ({
  chainId: CHAIN,
  sellToken: USDG.address,
  buyToken: WETH_ROBINHOOD.address,
  sellAmount: '5000000',          // 5 USDG at SIX decimals
  buyAmount: '2000000000000000',  // 0.002 WETH at eighteen
  minBuyAmount: '1980000000000000',
  to: ZEROX_ALLOWANCE_HOLDER,
  data: '0x1234567890abcdef',
  value: '0',
  gas: '250000',
  allowanceTarget: ZEROX_ALLOWANCE_HOLDER,
  ...over,
});

const expectFor = (over: Partial<Parameters<typeof verifyQuote>[0]['expect']> = {}) => ({
  chainId: CHAIN,
  sellToken: USDG.address,
  buyToken: WETH_ROBINHOOD.address,
  sellAmount: 5_000_000n,
  maxSlippageBps: 100,
  signerAddress: TAKER,
  ...over,
});

describe('the Robinhood live instrument', () => {
  it('exists, is tradable, and settles in the configured asset', () => {
    const inst = findInstrument(`CRYPTO_SPOT://robinhood/${'WETH'}-${SETTLEMENT.symbol}`);
    expect(inst).toBeTruthy();
    expect(inst!.venue).toBe(ROBINHOOD_VENUE);
    expect(inst!.network).toBe('robinhood');
    expect(inst!.tradable).toBe(true);
  });

  it('resolves a paper symbol to the real chain, addresses and decimals', () => {
    const r = resolveLiveInstrument('ETHUSDT');
    expect(r.mapped).toBe(true);
    expect(r.spec!.chainId).toBe(4663);
    expect(r.spec!.base.address.toLowerCase()).toBe(WETH_ROBINHOOD.address.toLowerCase());
    expect(r.spec!.quote.address.toLowerCase()).toBe(USDG.address.toLowerCase());
    // the asymmetry that governs every amount on this venue
    expect(r.spec!.base.decimals).toBe(18);
    expect(r.spec!.quote.decimals).toBe(6);
  });

  it('the spender is the verified 0x AllowanceHolder, not an arbitrary address', () => {
    expect(resolveLiveInstrument('ETHUSDT').spec!.spender.toLowerCase())
      .toBe('0x0000000000001ff3684f28c67538d4d072c22734');
  });

  it('refuses a symbol with no mapping rather than guessing', () => {
    const r = resolveLiveInstrument('DOGEUSDT');
    expect(r.mapped).toBe(false);
    expect(r.reason).toMatch(/no live instrument mapping/);
  });

  it('the live universe is deliberately ONE pair', () => {
    expect(mappedSymbols()).toEqual(['ETHUSDT']);
  });

  it('every mapping passes its own sanity checks', () => {
    const v = validateMappings();
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

describe('0x quote verification — never sign unexpected calldata', () => {
  it('accepts a quote that matches the approved intent', () => {
    expect(verifyQuote({ quote: goodQuote(), expect: expectFor() }).ok).toBe(true);
  });

  it('rejects the WRONG CHAIN', () => {
    const v = verifyQuote({ quote: goodQuote({ chainId: 8453 }), expect: expectFor() });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toMatch(/chainId 8453, expected 4663/);
  });

  it('rejects a WRONG SELL TOKEN', () => {
    const v = verifyQuote({
      quote: goodQuote({ sellToken: '0x1111111111111111111111111111111111111111' }),
      expect: expectFor(),
    });
    expect(v.failures.join(' ')).toMatch(/sellToken/);
  });

  it('rejects a WRONG BUY TOKEN — the ticker-collision defence', () => {
    const v = verifyQuote({
      quote: goodQuote({ buyToken: '0x2222222222222222222222222222222222222222' }),
      expect: expectFor(),
    });
    expect(v.failures.join(' ')).toMatch(/buyToken/);
  });

  it('rejects a SELL AMOUNT that is not what risk approved', () => {
    const v = verifyQuote({ quote: goodQuote({ sellAmount: '50000000' }), expect: expectFor() });
    expect(v.failures.join(' ')).toMatch(/sellAmount 50000000, expected 5000000/);
  });

  it('rejects an UNAPPROVED TRANSACTION TARGET', () => {
    const v = verifyQuote({
      quote: goodQuote({ to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      expect: expectFor(),
    });
    expect(v.failures.join(' ')).toMatch(/transaction target .* is not an approved 0x contract/);
  });

  it('rejects an UNAPPROVED ALLOWANCE SPENDER', () => {
    const v = verifyQuote({
      quote: goodQuote({ allowanceTarget: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      expect: expectFor(),
    });
    expect(v.failures.join(' ')).toMatch(/allowance spender .* is not approved/);
  });

  it('ENFORCES THE SLIPPAGE CEILING BEFORE SIGNING, not after the funds move', () => {
    // 2.0e15 -> 1.0e15 is 5000bps of slippage against a 100bps ceiling
    const v = verifyQuote({
      quote: goodQuote({ minBuyAmount: '1000000000000000' }),
      expect: expectFor({ maxSlippageBps: 100 }),
    });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toMatch(/guarantees only 5000bps .* ceiling is 100bps/);
  });

  it('accepts a guarantee TIGHTER than the ceiling', () => {
    const v = verifyQuote({
      quote: goodQuote({ minBuyAmount: '1999000000000000' }),
      expect: expectFor({ maxSlippageBps: 100 }),
    });
    expect(v.ok).toBe(true);
  });

  it('does not reject over ROUNDING — the bug a live dry run caught', () => {
    // 0x returned a minBuyAmount 2118 wei below our own recomputation of the
    // same figure: one part in a trillion, and the old check refused it.
    const v = verifyQuote({
      quote: goodQuote({ buyAmount: '2023620376960000', minBuyAmount: '2003384173190400' }),
      expect: expectFor({ maxSlippageBps: 100 }),
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a quote that guarantees nothing at all', () => {
    const v = verifyQuote({ quote: goodQuote({ minBuyAmount: '0' }), expect: expectFor() });
    expect(v.failures.join(' ')).toMatch(/guarantees nothing/);
  });

  it('rejects a quote that would send native value on an ERC-20 venue', () => {
    const v = verifyQuote({ quote: goodQuote({ value: '1000000000000000000' }), expect: expectFor() });
    expect(v.failures.join(' ')).toMatch(/native value/);
  });

  it('rejects missing or malformed calldata', () => {
    expect(verifyQuote({ quote: goodQuote({ data: '' }), expect: expectFor() }).ok).toBe(false);
    expect(verifyQuote({ quote: goodQuote({ data: '0x1' }), expect: expectFor() }).ok).toBe(false);
  });

  it('reports EVERY failure, not just the first', () => {
    const v = verifyQuote({
      quote: goodQuote({ chainId: 1, to: '0xdead', value: '5', sellAmount: '9' }),
      expect: expectFor(),
    });
    expect(v.failures.length).toBeGreaterThanOrEqual(4);
  });
});

describe('adapter registration', () => {
  const markOf = () => 2400;

  it('without a 0x key the Robinhood venue REFUSES rather than being absent', async () => {
    const previous = process.env.ZEROX_API_KEY;
    delete process.env.ZEROX_API_KEY;
    const adapters = buildAdapters(markOf, new NoSigner());
    const adapter = adapters.get(ROBINHOOD_VENUE);
    expect(adapter).toBeInstanceOf(NotConfiguredAdapter);
    // present-but-refusing is what stops the router falling through to shadow
    expect((await adapter!.placeOrder()).accepted).toBe(false);
    process.env.ZEROX_API_KEY = previous;
  });

  it('without a signer it also refuses, even with an API key', () => {
    const previous = process.env.ZEROX_API_KEY;
    process.env.ZEROX_API_KEY = 'test-key';
    const adapters = buildAdapters(markOf); // no signer passed
    expect(adapters.get(ROBINHOOD_VENUE)).toBeInstanceOf(NotConfiguredAdapter);
    process.env.ZEROX_API_KEY = previous;
  });
});

describe('routing: exact venue or nothing', () => {
  const markOf = () => 2400;
  const req = (mode: 'shadow' | 'canary' | 'live') => ({
    instrumentId: `CRYPTO_SPOT://robinhood/WETH-${SETTLEMENT.symbol}`,
    side: 'buy' as const, notionalUsd: 5, maxSlippageBps: 100, mode,
  });

  it('canary REFUSES when the Robinhood adapter is missing — no shadow fallback', () => {
    const adapters = buildAdapters(markOf);
    adapters.delete(ROBINHOOD_VENUE);
    const d = new ExecutionRouter(adapters).route(req('canary'));
    expect(d.routable).toBe(false);
    expect(d.reason).toMatch(/ADAPTER_UNAVAILABLE/);
  });

  it('live refuses the same way', () => {
    const adapters = buildAdapters(markOf);
    adapters.delete(ROBINHOOD_VENUE);
    expect(new ExecutionRouter(adapters).route(req('live')).routable).toBe(false);
  });

  it('and never routes a real-money order to a simulated venue', () => {
    const adapters = buildAdapters(markOf);
    // put the shadow adapter where the real one belongs
    adapters.set(ROBINHOOD_VENUE, adapters.get('shadow')!);
    const d = new ExecutionRouter(adapters).route(req('canary'));
    expect(d.routable).toBe(false);
    expect(d.reason).toMatch(/simulated venue/);
  });
});

describe('preflight, rebuilt around Robinhood Chain', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  const deps = (over: Record<string, unknown> = {}) => ({
    db,
    signer: new NoSigner(),
    adapters: buildAdapters(() => 2400),
    feedStatus: { binance: { connected: true, stale: false } },
    ...over,
  });

  it('live still fails closed with a NoSigner', async () => {
    const r = await runPreflight(deps(), 'live');
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.name === 'signer')!.pass).toBe(false);
  });

  it('names the Robinhood RPC variable, not the Base one', async () => {
    const previous = process.env.RPC_ROBINHOOD_PRIMARY;
    delete process.env.RPC_ROBINHOOD_PRIMARY;
    const r = await runPreflight(deps(), 'live');
    const rpc = r.checks.find((c) => c.name === 'rpc_primary')!;
    expect(rpc.pass).toBe(false);
    expect(rpc.detail).toMatch(/RPC_ROBINHOOD_PRIMARY/);
    expect(rpc.detail).not.toMatch(/RPC_BASE/);
    if (previous) process.env.RPC_ROBINHOOD_PRIMARY = previous;
  }, 30_000);

  it('checks the CONFIGURED settlement asset, not a hardcoded USDC', async () => {
    const r = await runPreflight(deps(), 'live');
    const funded = r.checks.find((c) => c.name === 'funded_balance')!;
    expect(funded.pass).toBe(false);
    expect(SETTLEMENT.symbol).toBe('USDG');
    expect(funded.detail).not.toMatch(/USDC/);
  }, 30_000);

  it('has a gas-reserve check, because a wallet that cannot pay gas cannot exit', async () => {
    const r = await runPreflight(deps(), 'live');
    expect(r.checks.find((c) => c.name === 'gas_reserve')).toBeTruthy();
  }, 30_000);

  it('mapping now passes — the live universe is configured', async () => {
    const r = await runPreflight(deps(), 'live');
    expect(r.checks.find((c) => c.name === 'instrument_mapping')!.pass).toBe(true);
  }, 30_000);

  it('live still demands 10 clean canary fills', async () => {
    const r = await runPreflight(deps(), 'live');
    const gate = r.checks.find((c) => c.name === 'canary_evidence')!;
    expect(gate.pass).toBe(false);
    expect(gate.detail).toMatch(/0 clean canary fill/);
  }, 30_000);
});

describe('the signer reports what the enclave actually enforces', () => {
  it('a wallet with NO OWNER never reads as "active"', async () => {
    const signer = new PrivySigner({
      appId: 'app', appSecret: 'secret', walletId: 'w1',
      expectedAddress: TAKER, authorizationKey: 'a-key-that-is-set',
      allowedTargets: [], maxNativeValueWei: 0n,
    });
    // Privy answers, address matches, but owner_id is null
    (signer as any).call = async () => ({ id: 'w1', address: TAKER, owner_id: null, policy_ids: [] });

    const r = await signer.isReady();
    expect(r.ready).toBe(true);
    // the bug this guards: "authorization key active" purely because the env
    // var existed, while Privy required no authorization signature at all
    expect(r.detail).not.toMatch(/active/);
    expect(r.detail).toMatch(/NO OWNER/);
    expect(r.detail).toMatch(/NO POLICY/);
    expect(signer.guards().ownerEnforced).toBe(false);
    expect(signer.guards().fullyGuarded).toBe(false);
  });

  it('reports both walls when the enclave really has them', async () => {
    const signer = new PrivySigner({
      appId: 'app', appSecret: 'secret', walletId: 'w1',
      expectedAddress: TAKER, allowedTargets: [], maxNativeValueWei: 0n,
    });
    (signer as any).call = async () => ({ id: 'w1', address: TAKER, owner_id: 'quorum_1', policy_ids: ['pol_1'] });

    const r = await signer.isReady();
    expect(r.detail).toMatch(/owner quorum_1 enforced/);
    expect(r.detail).toMatch(/1 policy\(ies\) attached/);
    expect(signer.guards().fullyGuarded).toBe(true);
  });

  it('still refuses outright when the wallet id resolves elsewhere', async () => {
    const signer = new PrivySigner({
      appId: 'app', appSecret: 'secret', walletId: 'w1',
      expectedAddress: TAKER, allowedTargets: [], maxNativeValueWei: 0n,
    });
    (signer as any).call = async () => ({
      id: 'w1', address: '0x1111111111111111111111111111111111111111', owner_id: 'q', policy_ids: ['p'],
    });
    const r = await signer.isReady();
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(/WALLET MISMATCH/);
  });
});
