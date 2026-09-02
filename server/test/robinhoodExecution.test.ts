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
import { reconcileAccount } from '../src/live/reconciler.js';
import { accountForMode, bindTraderWallet, fundingFor, recordFunding } from '../src/live/accounts.js';
import { NoSigner } from '../src/live/signing/signer.js';
import { PrivySigner } from '../src/live/signing/privySigner.js';
import { encodeFunctionData } from 'viem';

const CHAIN = ROBINHOOD_MAINNET_CHAIN_ID;
const TAKER = '0xD5788b6694a05366FaaeEfEff35c7a5913D02Ff9';
const SIGNER_TARGETS = [USDG.address, WETH_ROBINHOOD.address, ZEROX_ALLOWANCE_HOLDER];
const ALLOWANCE_HOLDER_ABI = [{
  name: 'exec', type: 'function', stateMutability: 'payable',
  inputs: [
    { name: 'operator', type: 'address' }, { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }, { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
  ],
  outputs: [{ name: 'result', type: 'bytes' }],
}] as const;
const SETTLER_ABI = [{
  name: 'execute', type: 'function', stateMutability: 'payable',
  inputs: [
    {
      name: 'slippage', type: 'tuple', components: [
        { name: 'recipient', type: 'address' }, { name: 'buyToken', type: 'address' },
        { name: 'minAmountOut', type: 'uint256' },
      ],
    },
    { name: 'actions', type: 'bytes[]' }, { name: 'zidAndAffiliate', type: 'bytes32' },
  ],
  outputs: [{ type: 'bool' }],
}] as const;

const allowanceCalldata = (over: {
  operator?: string; token?: string; amount?: bigint; target?: string;
  recipient?: string; buyToken?: string; minAmountOut?: bigint;
} = {}) => {
  const inner = encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'execute',
    args: [
      {
        recipient: (over.recipient ?? TAKER) as `0x${string}`,
        buyToken: (over.buyToken ?? WETH_ROBINHOOD.address) as `0x${string}`,
        minAmountOut: over.minAmountOut ?? 1_980_000_000_000_000n,
      },
      ['0x1234'],
      `0x${'00'.repeat(32)}`,
    ],
  });
  return encodeFunctionData({
    abi: ALLOWANCE_HOLDER_ABI,
    functionName: 'exec',
    args: [
      (over.operator ?? TAKER) as `0x${string}`,
      (over.token ?? USDG.address) as `0x${string}`,
      over.amount ?? 5_000_000n,
      (over.target ?? TAKER) as `0x${string}`,
      inner,
    ],
  });
};

/** a quote shaped exactly like a good one, so each test can spoil ONE field */
const goodQuote = (over: Partial<ZeroXQuote> = {}): ZeroXQuote => ({
  chainId: CHAIN,
  sellToken: USDG.address,
  buyToken: WETH_ROBINHOOD.address,
  sellAmount: '5000000',          // 5 USDG at SIX decimals
  buyAmount: '2000000000000000',  // 0.002 WETH at eighteen
  minBuyAmount: '1980000000000000',
  to: ZEROX_ALLOWANCE_HOLDER,
  data: allowanceCalldata(),
  value: '0',
  gas: '250000',
  allowanceTarget: ZEROX_ALLOWANCE_HOLDER,
  quotedAt: Date.now(),
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
      quote: goodQuote({
        minBuyAmount: '1999000000000000',
        data: allowanceCalldata({ minAmountOut: 1_999_000_000_000_000n }),
      }),
      expect: expectFor({ maxSlippageBps: 100 }),
    });
    expect(v.ok).toBe(true);
  });

  it('does not reject over ROUNDING — the bug a live dry run caught', () => {
    // 0x returned a minBuyAmount 2118 wei below our own recomputation of the
    // same figure: one part in a trillion, and the old check refused it.
    const v = verifyQuote({
      quote: goodQuote({
        buyAmount: '2023620376960000', minBuyAmount: '2003384173190400',
        data: allowanceCalldata({ minAmountOut: 2_003_384_173_190_400n }),
      }),
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

  it('rejects a stale firm quote before signing', () => {
    const v = verifyQuote({ quote: goodQuote({ quotedAt: Date.now() - 15_001 }), expect: expectFor() });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toMatch(/timestamp .* stale/);
  });

  it('decodes calldata and rejects a different token, amount, or operator', () => {
    const token = verifyQuote({
      quote: goodQuote({ data: allowanceCalldata({ token: WETH_ROBINHOOD.address }) }), expect: expectFor(),
    });
    expect(token.failures.join(' ')).toMatch(/calldata token/);

    const amount = verifyQuote({
      quote: goodQuote({ data: allowanceCalldata({ amount: 50_000_000n }) }), expect: expectFor(),
    });
    expect(amount.failures.join(' ')).toMatch(/calldata amount/);

    const operator = verifyQuote({
      quote: goodQuote({ data: allowanceCalldata({ operator: '0x1111111111111111111111111111111111111111' }) }),
      expect: expectFor(),
    });
    expect(operator.failures.join(' ')).toMatch(/operator .* does not match target/);
  });

  it('rejects altered settlement recipient, buy token, or minimum output', () => {
    const recipient = verifyQuote({
      quote: goodQuote({ data: allowanceCalldata({ recipient: '0x1111111111111111111111111111111111111111' }) }),
      expect: expectFor(),
    });
    expect(recipient.failures.join(' ')).toMatch(/calldata recipient/);

    const buyToken = verifyQuote({
      quote: goodQuote({ data: allowanceCalldata({ buyToken: USDG.address }) }), expect: expectFor(),
    });
    expect(buyToken.failures.join(' ')).toMatch(/calldata buy token/);

    const minimum = verifyQuote({
      quote: goodQuote({ data: allowanceCalldata({ minAmountOut: 1n }) }), expect: expectFor(),
    });
    expect(minimum.failures.join(' ')).toMatch(/calldata minimum/);
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

  it('anchors an operator probe to the firm quote while retaining the reference floor for strategy orders', async () => {
    const receivedFloors: Array<number | undefined> = [];
    const adapter = {
      venue: ROBINHOOD_VENUE,
      async health() { return { venue: ROBINHOOD_VENUE, status: 'online', latencyMs: 1, errorRate: 0, lastOkAt: 1, note: null }; },
      async getQuote() { return null; },
      async placeOrder(_instrument: unknown, _side: unknown, _notional: unknown, opts: { minReceive?: number }) {
        receivedFloors.push(opts.minReceive);
        return { accepted: true, pending: true, txRef: '0xtest', venueOrderId: '0xtest' };
      },
    };
    const router = new ExecutionRouter(new Map([[ROBINHOOD_VENUE, adapter as any]]));
    const strategy = { ...req('canary'), intentId: 'strategy', orderId: 1, accountId: 1 };
    const probe = { ...strategy, intentId: 'probe', operatorTest: true };

    await router.execute(router.route(strategy), strategy, 2400);
    await router.execute(router.route(probe), probe, 2400);

    expect(receivedFloors[0]).toBeCloseTo(5 / (2400 * 1.01));
    expect(receivedFloors[1]).toBeUndefined();
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

  it('waives entry collateral only for attested exit recovery while keeping the other gates blocking', async () => {
    const r = await runPreflight(deps(), 'canary', 'test', {
      persist: false,
      targetStage: 1,
      purpose: 'exit_recovery',
      exitRecoveryEvidence: true,
    });
    expect(r.checks.find((c) => c.name === 'exit_recovery_evidence')).toMatchObject({ pass: true, blocking: true });
    expect(r.checks.find((c) => c.name === 'stage_collateralized')).toMatchObject({ pass: true, blocking: true });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.name === 'signer')).toMatchObject({ pass: false, blocking: true });
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
      allowedTargets: SIGNER_TARGETS, maxNativeValueWei: 0n,
    });
    // Privy answers, address matches, but owner_id is null
    (signer as any).call = async () => ({ id: 'w1', address: TAKER, owner_id: null, policy_ids: [] });

    const r = await signer.isReady();
    expect(r.ready).toBe(false);
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
      expectedAddress: TAKER, authorizationKey: 'configured-for-readiness',
      expectedPolicyIds: ['pol_1'], allowedTargets: SIGNER_TARGETS, maxNativeValueWei: 0n,
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

describe('external funding vs reconciliation', () => {
  let db: DB;
  let accountId: number;

  /** an adapter that reports whatever the "chain" is said to hold */
  const chainHolding = (balances: { asset: string; qty: number }[]) => ({
    venue: ROBINHOOD_VENUE,
    async health() { return { venue: ROBINHOOD_VENUE, status: 'online' as const, latencyMs: 1, errorRate: 0, lastOkAt: Date.now(), note: null }; },
    async getQuote() { return null; },
    async placeOrder() { return { accepted: false, error: 'test adapter' }; },
    async getBalances() { return balances; },
    async reconcile() { return { ok: true, balances, positions: [], detail: 'test' }; },
  });

  beforeEach(() => {
    db = openTestDb();
    accountId = bindTraderWallet(db, TAKER).id;
  });

  it('an unrecorded deposit HALTS — the reconciler is right, the ledger is incomplete', async () => {
    const pass = await reconcileAccount(db, null, accountId, chainHolding([
      { asset: 'ETH', qty: 0.00283351 }, { asset: 'USDG', qty: 4.999992 },
    ]) as any);
    expect(pass.ok).toBe(false);
    expect(pass.drifts.map((d) => d.asset).sort()).toEqual(['ETH', 'USDG']);
  });

  it('recording what was actually deposited makes it reconcile', () => {
    recordFunding(db, accountId, [
      { asset: 'ETH', qty: 0.00283351, note: 'bridge', txRef: '0xdeposit', logIndex: -1 },
      { asset: 'USDG', qty: 4.999992, note: 'bridge', txRef: '0xdeposit', logIndex: 0 },
    ], 'operator:test');
    expect(fundingFor(db, accountId).get('USDG')).toBeCloseTo(4.999992, 6);
  });

  it('AND STILL CATCHES REAL DRIFT — funding is not a blanket excuse', async () => {
    recordFunding(db, accountId, [{ asset: 'USDG', qty: 5, txRef: '0xdrift', logIndex: 0 }], 'operator:test');
    // the chain says most of it left; nothing in the ledger explains that
    const pass = await reconcileAccount(db, null, accountId, chainHolding([
      { asset: 'USDG', qty: 1 },
    ]) as any);
    expect(pass.ok).toBe(false);
    expect(pass.drifts[0].drift).toBeCloseTo(-4, 6);
  });

  it('an operator who attests the WRONG amount does not get a clean pass', async () => {
    recordFunding(db, accountId, [{ asset: 'USDG', qty: 50, txRef: '0xwrong', logIndex: 0 }], 'operator:test'); // claimed 50
    const pass = await reconcileAccount(db, null, accountId, chainHolding([
      { asset: 'USDG', qty: 5 },                                                // chain has 5
    ]) as any);
    expect(pass.ok).toBe(false);
  });

  it('every funding record is audited and attributable', () => {
    recordFunding(db, accountId, [{ asset: 'USDG', qty: 5, txRef: '0xabc', logIndex: 0 }], 'operator:ember');
    const row = db.prepare(`SELECT * FROM execution_account_funding`).get() as any;
    expect(row.actor).toBe('operator:ember');
    expect(row.tx_ref).toBe('0xabc');
    expect(row.audit_hash).toBeTruthy();
    expect((db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='account_funding'`).get() as any).n).toBe(1);
  });

  it('a withdrawal is a negative entry, not a deletion', () => {
    recordFunding(db, accountId, [{ asset: 'USDG', qty: 5, txRef: '0xin', logIndex: 0 }], 'operator:test');
    recordFunding(db, accountId, [{ asset: 'USDG', qty: -2, txRef: '0xout', logIndex: 0 }], 'operator:test');
    expect(fundingFor(db, accountId).get('USDG')).toBeCloseTo(3, 6);
    expect((db.prepare(`SELECT COUNT(*) n FROM execution_account_funding`).get() as any).n).toBe(2);
  });

  it('cannot import the same onchain funding transfer twice', () => {
    const entry = { asset: 'USDG', qty: 5, txRef: '0xonce', logIndex: 7 };
    recordFunding(db, accountId, [entry], 'operator:test');
    expect(() => recordFunding(db, accountId, [entry], 'operator:test')).toThrow(/UNIQUE/);
    expect((db.prepare(`SELECT COUNT(*) n FROM execution_asset_ledger WHERE event_type='funding'`).get() as any).n).toBe(1);
  });

  it('does not let hashless legacy attestations collateralize a canary', async () => {
    db.prepare(
      `INSERT INTO execution_account_funding
        (execution_account_id, asset, qty, tx_ref, actor, note, audit_hash, ts, log_index)
       VALUES (?, 'USDG', 5, NULL, 'legacy', 'unproven', 'hash', 1, NULL)`,
    ).run(accountId);
    const signer = {
      kind: 'test',
      async isReady() { return { ready: false, detail: 'test' }; },
      async getAddress() { return null; },
    } as any;
    const result = await runPreflight({
      db, signer, adapters: new Map(), feedStatus: {}, ethUsd: null,
    }, 'canary', 'test', { persist: false, targetStage: 1 });
    expect(result.checks.find((check) => check.name === 'funding_provenance')).toMatchObject({
      pass: false,
      blocking: true,
    });
  });
});
