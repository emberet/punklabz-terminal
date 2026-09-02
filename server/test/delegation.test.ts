import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { CEILING_TIERS, ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD, type DelegationCaps } from '@punklabz/shared';
import {
  checkTokens, delegationCeiling, earnedTier, effectiveCaps, evaluateDelegation,
  grantHeadroomUsd, grantSpend, releaseSpend, reserveSpend, settleSpend,
  type DelegationEvidence,
} from '../src/live/delegation/delegationPolicy.js';
import {
  activateGrant, createGrant, expireDueGrants, listGrants, revokeGrant, setGrantPaused,
} from '../src/live/delegation/grants.js';
import { ExecutionRouter } from '../src/live/executionRouter.js';
import { buildAdapters } from '../src/live/adapters.js';
import { runDelegationPreflight, runPreflight } from '../src/live/preflight.js';
import { NoSigner } from '../src/live/signing/signer.js';
import { buildDelegationProvider, NullDelegationProvider } from '../src/live/delegation/provider.js';
import { revocationCache, RevocationCacheImpl } from '../src/live/delegation/revocationCache.js';
import type { LiveInstrumentSpec } from '../src/live/instrumentResolver.js';
import {
  evaluateIntent, getLiveConfig, haltNetwork, updateLimits,
} from '../src/live/riskEngine.js';
import type { OrderIntent } from '@punklabz/shared';
import { toMicro } from '../src/money.js';

const NOW = Date.now();
const YEAR = 365 * 86_400_000;

function seedUserAndBot(db: DB): { userId: number; botId: number } {
  const u = db
    .prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('a@b.c', 'Ember', ?)`)
    .run(NOW);
  const b = db
    .prepare(
      `INSERT INTO bots (owner_user_id, name, kind, strategy_type, config_json, created_at)
       VALUES (?, 'DELEGATE-1', 'quant', 'momentum', '{}', ?)`,
    )
    .run(Number(u.lastInsertRowid), NOW);
  return { userId: Number(u.lastInsertRowid), botId: Number(b.lastInsertRowid) };
}

/** lift the stored ceiling so cap arithmetic is testable; earned tier still gates production */
function forceStoredTier(db: DB, tier: number) {
  const spec = CEILING_TIERS[tier];
  db.prepare(
    `INSERT INTO delegation_ceiling
       (tier, per_trade_cap_micro, cumulative_cap_micro, daily_cap_micro,
        max_grants_per_user, max_total_delegated_micro, evidence_json, effective_at, actor)
     VALUES (?, ?, ?, ?, ?, ?, '{"reason":"test"}', ?, 'test')`,
  ).run(
    tier, toMicro(spec.perTradeUsd), toMicro(spec.cumulativeUsd), toMicro(spec.dailyUsd),
    spec.maxGrantsPerUser, toMicro(spec.maxTotalDelegatedUsd), Date.now(),
  );
}

/** the evidence a tier-1 network would actually have produced */
function tier1Evidence(db: DB, fills = 30) {
  const acct = db
    .prepare(
      `INSERT INTO execution_accounts (name, mode, venue, created_at) VALUES ('live-t', 'live', 'evm:base', ?)`,
    )
    .run(NOW);
  const acctId = Number(acct.lastInsertRowid);
  const stmt = db.prepare(
    `INSERT INTO live_orders (intent_id, execution_account_id, instrument_id, venue, side,
       requested_notional_micro, mode, state, created_at, updated_at)
     VALUES (?, ?, 'x', 'evm:base', 'buy', 1000000, 'live', 'filled', ?, ?)`,
  );
  const fifteenDaysAgo = NOW - 15 * 86_400_000;
  for (let i = 0; i < fills; i++) stmt.run(`fill-${i}`, acctId, fifteenDaysAgo, fifteenDaysAgo);
  getLiveConfig(db); // create the config row before writing to it
  db.prepare(`UPDATE live_config SET mode = 'live' WHERE id = 1`).run();
}

function makeGrant(db: DB, caps: Partial<DelegationCaps> = {}, botOffset = 0) {
  const { userId, botId } = botOffset === 0 ? seedUserAndBot(db) : seedUserAndBot(db);
  const { grantId } = createGrant(db, {
    userId, botId,
    providerUserId: 'privy:user_123',
    walletAddress: '0xAbC0000000000000000000000000000000000001',
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    requested: {
      perTradeUsd: 5, dailyUsd: 10, cumulativeUsd: 25,
      maxOpenNotionalUsd: 25, maxSlippageBps: 50, ...caps,
    },
    allowedTokens: [
      { address: WETH_ROBINHOOD.address, symbol: 'WETH', decimals: 18, role: 'base' },
      { address: USDG.address, symbol: 'USDG', decimals: 6, role: 'quote' },
    ],
    expiresAt: Date.now() + 30 * 86_400_000,
  });
  return { grantId, userId, botId };
}

function activateDirectly(db: DB, grantId: number) {
  db.prepare(
    `UPDATE delegation_grants SET status = 'active', session_signer_id = 'ss_test', policy_id = 'pol_test' WHERE id = ?`,
  ).run(grantId);
  revocationCache.restore(grantId);
}

const SPEC: LiveInstrumentSpec = {
  id: 'CRYPTO_SPOT://robinhood/WETH-USDG',
  venue: 'evm:robinhood',
  chainId: ROBINHOOD_MAINNET_CHAIN_ID,
  base: { chainId: ROBINHOOD_MAINNET_CHAIN_ID, address: WETH_ROBINHOOD.address, symbol: 'WETH', decimals: 18 },
  quote: { chainId: ROBINHOOD_MAINNET_CHAIN_ID, address: USDG.address, symbol: 'USDG', decimals: 6 },
  spender: '0xRouter',
  minNotionalUsd: 2,
};

const EV_ZERO: DelegationEvidence = {
  liveFills: 0, daysSinceFirstLiveFill: 0, reconClean30d: true, haltsLast30d: 0,
  capBreachIncidents: 0, externallyAudited: false, drawdownPct: 0, failedOrders: 0,
  modeIsLive: false,
};

describe('the ceiling ladder', () => {
  it('a network with no live history has earned exactly $0 of delegation', () => {
    const db = openTestDb();
    const c = delegationCeiling(db);
    expect(c.tier).toBe(0);
    expect(c.perTradeUsd).toBe(0);
    expect(c.maxGrantsPerUser).toBe(0);
    expect(c.blockers).toContain('execution mode is not live');
  });

  it('a tier is earned from measured evidence, never asserted', () => {
    expect(earnedTier(EV_ZERO)).toBe(0);
    // everything but the fills
    expect(earnedTier({ ...EV_ZERO, modeIsLive: true, daysSinceFirstLiveFill: 20, liveFills: 24 })).toBe(0);
    const t1 = { ...EV_ZERO, modeIsLive: true, liveFills: 25, daysSinceFirstLiveFill: 14 };
    expect(earnedTier(t1)).toBe(1);
    // a single failed order drops it back to zero, not to a lower non-zero tier
    expect(earnedTier({ ...t1, failedOrders: 1 })).toBe(0);
    expect(earnedTier({ ...t1, liveFills: 300, daysSinceFirstLiveFill: 61 })).toBe(2);
    // tier 3 needs the external audit, and no amount of fills substitutes
    expect(earnedTier({ ...t1, liveFills: 5000, daysSinceFirstLiveFill: 400 })).toBe(2);
    expect(earnedTier({ ...t1, liveFills: 5000, daysSinceFirstLiveFill: 400, externallyAudited: true })).toBe(3);
  });

  it('the stored ceiling can only hold the tier down, never lift it', () => {
    const db = openTestDb();
    forceStoredTier(db, 3); // an admin sets the highest tier they can
    expect(delegationCeiling(db).tier).toBe(0); // evidence still says zero
    tier1Evidence(db);
    expect(delegationCeiling(db).tier).toBe(1); // and now evidence, not the admin, decides
    forceStoredTier(db, 0);
    expect(delegationCeiling(db).tier).toBe(0); // holding it lower is always allowed
  });

  it('no exported policy function accepts a force-style override', () => {
    const forceish = /force|override|bypass|skip/i;
    for (const fn of [delegationCeiling, earnedTier, effectiveCaps, evaluateDelegation, grantHeadroomUsd]) {
      expect(fn.toString().slice(0, 400)).not.toMatch(forceish);
    }
  });
});

describe('cap clamping', () => {
  it('what the user typed is bounded by the tier in force', () => {
    const ceiling = { ...delegationCeiling(openTestDb()), tier: 1, perTradeUsd: 5, dailyUsd: 10, cumulativeUsd: 25 };
    const { caps, clampedFields } = effectiveCaps(
      { perTradeUsd: 5000, dailyUsd: 5000, cumulativeUsd: 5000, maxOpenNotionalUsd: 5000, maxSlippageBps: 900 },
      ceiling,
    );
    expect(caps.perTradeUsd).toBe(5);
    expect(caps.cumulativeUsd).toBe(25);
    expect(caps.maxSlippageBps).toBe(35);
    expect(clampedFields).toContain('maxSlippageBps');
    expect(clampedFields).toContain('perTradeUsd');
  });

  it('at tier 0 every requested cap clamps to zero', () => {
    const db = openTestDb();
    const { caps } = effectiveCaps(
      { perTradeUsd: 1000, dailyUsd: 1000, cumulativeUsd: 1000, maxOpenNotionalUsd: 1000, maxSlippageBps: 50 },
      delegationCeiling(db),
    );
    expect(caps).toMatchObject({ perTradeUsd: 0, dailyUsd: 0, cumulativeUsd: 0 });
  });

  it('a grant cannot be created at all while the ceiling allows zero grants', () => {
    const db = openTestDb();
    expect(() => makeGrant(db)).toThrow(/grant limit reached/);
  });
});

describe('grant lifecycle', () => {
  let db: DB;
  beforeEach(() => {
    db = openTestDb();
    tier1Evidence(db);
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
  });

  it('a new grant is pending, clamped, and cannot spend', () => {
    const { grantId } = makeGrant(db, { perTradeUsd: 999 });
    const row = db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId) as any;
    expect(row.status).toBe('pending');
    expect(row.per_trade_cap_micro).toBe(toMicro(5));
    expect(row.ceiling_tier).toBe(1);
    // frozen for a later dispute
    expect(JSON.parse(row.ceiling_evidence_json).liveFills).toBe(30);
    expect(revocationCache.isRevoked(grantId)).toBe(true);
    const checks = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 1 }, 1);
    expect(checks.find((c) => c.name === 'delegation_grant')?.pass).toBe(false);
  });

  it('activation requires a provider, and there is no provider in this build', async () => {
    const { grantId } = makeGrant(db);
    const provider = buildDelegationProvider();
    expect(provider).toBeInstanceOf(NullDelegationProvider);
    expect((await provider.isReady()).ready).toBe(false);
    await expect(activateGrant(db, provider, grantId, 'ss_x', 'test'))
      .rejects.toThrow(/no provider configured/);
  });

  it('an active grant passes its own checks and reports honest headroom', () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    expect(grantHeadroomUsd(db, grantId)).toBe(5);
    const checks = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 4 }, 4);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.pass]));
    expect(byName.delegation_grant).toBe(true);
    expect(byName.delegation_per_trade).toBe(true);
    expect(byName.delegation_signer).toBe(true);
    expect(byName.delegation_token).toBe(true);
  });

  it('a size over the per-trade cap is refused with the numbers in the reason', () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    const c = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 40 }, 40)
      .find((x) => x.name === 'delegation_per_trade')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/\$40\.00 over per-trade cap \$5\.00/);
  });

  it('a refusal is written to the grant audit trail', () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 40 }, 40);
    const denied = db
      .prepare(`SELECT * FROM delegation_events WHERE grant_id = ? AND event = 'cap_denied'`)
      .all(grantId) as any[];
    expect(denied).toHaveLength(1);
    expect(JSON.parse(denied[0].detail_json).failed).toContain('delegation_per_trade');
  });

  it('pausing stops spending; resuming restores it; both hit the cache', () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    setGrantPaused(db, grantId, true, 'owner');
    expect(revocationCache.isRevoked(grantId)).toBe(true);
    setGrantPaused(db, grantId, false, 'owner');
    expect(revocationCache.isRevoked(grantId)).toBe(false);
  });

  it('an expired grant stops spending with nobody acting', () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    db.prepare(`UPDATE delegation_grants SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, grantId);
    expect(expireDueGrants(db)).toBe(1);
    expect((db.prepare(`SELECT status FROM delegation_grants WHERE id=?`).get(grantId) as any).status).toBe('expired');
    expect(revocationCache.isRevoked(grantId)).toBe(true);
  });
});

describe('revocation', () => {
  let db: DB;
  beforeEach(() => {
    db = openTestDb();
    tier1Evidence(db);
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
  });

  function orderFor(db: DB, grantId: number, state: string, intent: string) {
    const acct = db.prepare(`SELECT id FROM execution_accounts LIMIT 1`).get() as any;
    db.prepare(
      `INSERT INTO live_orders (intent_id, execution_account_id, instrument_id, venue, side,
         requested_notional_micro, mode, state, delegation_grant_id, created_at, updated_at)
       VALUES (?, ?, 'x', 'evm:base', 'buy', 5000000, 'live', ?, ?, ?, ?)`,
    ).run(intent, acct.id, state, grantId, NOW, NOW);
  }

  it('cancels what has not been sent and admits what cannot be recalled', async () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    orderFor(db, grantId, 'risk_approved', 'not-sent-yet');
    orderFor(db, grantId, 'submitted', 'already-on-chain');

    const result = await revokeGrant(db, new NullDelegationProvider(), new Map(), grantId, 'owner');
    expect(result.revoked).toBe(true);
    expect(result.inFlightCancelled).toBe(1);
    expect(result.unstoppable).toHaveLength(1);
    expect(result.detail).toMatch(/cannot be recalled/);
    expect(revocationCache.isRevoked(grantId)).toBe(true);
  });

  it('revocation succeeds even when the provider is unreachable', async () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    const brokenProvider = {
      ...new NullDelegationProvider(),
      kind: 'broken',
      isReady: async () => ({ ready: false, detail: 'down' }),
      verifySessionSigner: async () => { throw new Error('down'); },
      applyPolicy: async () => { throw new Error('down'); },
      revokeSessionSigner: async () => { throw new Error('provider is down'); },
    };
    const result = await revokeGrant(db, brokenProvider as any, new Map(), grantId, 'owner');
    expect(result.revoked).toBe(true);
    expect(result.providerRevoked).toBe(false);
    expect((db.prepare(`SELECT status FROM delegation_grants WHERE id=?`).get(grantId) as any).status).toBe('revoked');
  });

  it('revoking twice is safe', async () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    await revokeGrant(db, new NullDelegationProvider(), new Map(), grantId, 'owner');
    const second = await revokeGrant(db, new NullDelegationProvider(), new Map(), grantId, 'owner');
    expect(second.revoked).toBe(true);
  });

  it('a revoked grant blocks buys but still lets the owner close a position', () => {
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    db.prepare(`UPDATE delegation_grants SET status = 'revoked' WHERE id = ?`).run(grantId);

    const buy = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 1 }, 1, true);
    expect(buy.every((c) => c.pass)).toBe(false);

    const sell = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'sell', notionalUsd: 1 }, 1, true);
    expect(sell.every((c) => c.pass)).toBe(true);
    expect(sell[0].name).toBe('delegation_exit_only');

    // but only when there IS something to close
    const sellNothing = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'sell', notionalUsd: 1 }, 1, false);
    expect(sellNothing.every((c) => c.pass)).toBe(false);
  });
});

describe('the usage ledger', () => {
  let db: DB;
  let grantId: number;
  beforeEach(() => {
    db = openTestDb();
    tier1Evidence(db);
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
    grantId = makeGrant(db).grantId;
    activateDirectly(db, grantId);
  });

  it('a reservation consumes headroom before the order is filled', () => {
    expect(grantHeadroomUsd(db, grantId)).toBe(5);
    reserveSpend(db, grantId, 'i-1', 'ETHUSDT', 4);
    expect(grantSpend(db, grantId).reservedUsd).toBe(4);
    // daily cap is $10 — $4 is committed, $6 remains, per-trade still caps at $5
    expect(grantHeadroomUsd(db, grantId)).toBe(5);
    reserveSpend(db, grantId, 'i-2', 'ETHUSDT', 5);
    expect(grantHeadroomUsd(db, grantId)).toBe(1); // $10 daily − $9 committed
  });

  it('two concurrent intents cannot spend the same cap twice', () => {
    // the same intent id can only reserve once — the unique index is the lock
    expect(reserveSpend(db, grantId, 'same-intent', 'ETHUSDT', 5)).toBe(true);
    expect(reserveSpend(db, grantId, 'same-intent', 'ETHUSDT', 5)).toBe(false);
    expect(grantSpend(db, grantId).reservedUsd).toBe(5);

    // and a second distinct intent is refused by the daily cap once committed
    reserveSpend(db, grantId, 'other-intent', 'ETHUSDT', 5);
    const c = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 5 }, 5)
      .find((x) => x.name === 'delegation_daily')!;
    expect(c.pass).toBe(false);
  });

  it('settling replaces the reservation with what actually happened', () => {
    reserveSpend(db, grantId, 'i-1', 'ETHUSDT', 5);
    settleSpend(db, grantId, 'i-1', 'ETHUSDT', 4.2);
    const spend = grantSpend(db, grantId);
    expect(spend.reservedUsd).toBe(0);
    expect(spend.settledUsd).toBeCloseTo(4.2, 6);
    expect(spend.usedUsd).toBeCloseTo(4.2, 6);
  });

  it('an order that never reached a venue gives the cap back', () => {
    reserveSpend(db, grantId, 'i-1', 'ETHUSDT', 5);
    expect(grantSpend(db, grantId).usedUsd).toBe(5);
    releaseSpend(db, grantId, 'i-1', 'ETHUSDT', 'router refused');
    expect(grantSpend(db, grantId).usedUsd).toBe(0);
    expect(grantHeadroomUsd(db, grantId)).toBe(5);
  });

  it('spend never goes negative, however the ledger is written', () => {
    releaseSpend(db, grantId, 'never-reserved', 'ETHUSDT', 'noop');
    const spend = grantSpend(db, grantId);
    expect(spend.reservedUsd).toBeGreaterThanOrEqual(0);
    expect(spend.todayUsd).toBeGreaterThanOrEqual(0);
  });

  it('the lifetime cap is enforced from the ledger, not from anything a client sends', () => {
    for (let i = 0; i < 5; i++) settleSpend(db, grantId, `hist-${i}`, 'ETHUSDT', 5);
    expect(grantSpend(db, grantId).settledUsd).toBe(25);
    expect(grantHeadroomUsd(db, grantId)).toBe(0);
    const c = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 1 }, 1)
      .find((x) => x.name === 'delegation_cumulative')!;
    expect(c.pass).toBe(false);
  });

  it('lowering the ceiling shrinks a grant already signed — no grandfathering', () => {
    expect(
      evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 1 }, 1)
        .find((x) => x.name === 'delegation_ceiling')!.pass,
    ).toBe(true);
    forceStoredTier(db, 0);
    const c = evaluateDelegation(db, grantId, { instrumentId: 'x/ETHUSDT', side: 'buy', notionalUsd: 1 }, 1)
      .find((x) => x.name === 'delegation_ceiling')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/exceeds current tier 0 ceiling/);
  });
});

describe('token whitelisting', () => {
  const allowed = [
    { token_address: WETH_ROBINHOOD.address.toLowerCase(), role: 'base' },
    { token_address: USDG.address.toLowerCase(), role: 'quote' },
  ];

  it('accepts a pair whose both legs are whitelisted, case-insensitively', () => {
    const checks = checkTokens(SPEC, allowed, ROBINHOOD_MAINNET_CHAIN_ID);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it('refuses when only the base is whitelisted — the quote is what gets spent', () => {
    const c = checkTokens(SPEC, [allowed[0]], ROBINHOOD_MAINNET_CHAIN_ID).find((x) => x.name === 'delegation_token')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/USDG/);
  });

  it('refuses a token whitelisted in the wrong role', () => {
    const swapped = [
      { token_address: WETH_ROBINHOOD.address.toLowerCase(), role: 'quote' },
      { token_address: USDG.address.toLowerCase(), role: 'base' },
    ];
    expect(checkTokens(SPEC, swapped, ROBINHOOD_MAINNET_CHAIN_ID).find((x) => x.name === 'delegation_token')!.pass).toBe(false);
  });

  it('refuses a right-looking pair on the wrong chain', () => {
    const c = checkTokens(SPEC, allowed, 1).find((x) => x.name === 'delegation_chain')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/chain 4663.*grant is 1/);
  });

  it('an empty whitelist can buy nothing', () => {
    expect(checkTokens(SPEC, [], ROBINHOOD_MAINNET_CHAIN_ID).find((x) => x.name === 'delegation_token')!.pass).toBe(false);
  });
});

describe('the revocation cache', () => {
  it('fails closed before it has been hydrated', () => {
    const cold = new RevocationCacheImpl();
    expect(cold.isHydrated()).toBe(false);
    // an id it has never heard of is treated as revoked, not as permitted
    expect(cold.isRevoked(12_345)).toBe(true);

    cold.hydrate(openTestDb());
    expect(cold.isRevoked(12_345)).toBe(false);
  });

  it('hydration picks up every non-spendable status', () => {
    const db = openTestDb();
    tier1Evidence(db);
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
    const { grantId } = makeGrant(db);
    activateDirectly(db, grantId);
    db.prepare(`UPDATE delegation_grants SET status = 'exhausted' WHERE id = ?`).run(grantId);
    revocationCache.hydrate(db); // simulate a restart
    expect(revocationCache.isRevoked(grantId)).toBe(true);
  });
});

describe('the risk gate with a grant attached', () => {
  let db: DB;
  let grantId: number;

  const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
    intentId: `d_${Math.random().toString(36).slice(2)}`,
    botId: 1,
    instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
    venue: 'paper',
    side: 'buy',
    notionalUsd: 50,
    confidence: 99,
    reason: 'delegated',
    ...over,
  });

  beforeEach(() => {
    db = openTestDb();
    tier1Evidence(db, 40);          // enough fills for the top capital stage
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
    db.prepare(`UPDATE live_config SET capital_stage=4 WHERE id=1`).run(); // test fixture: $100 network cap
    updateLimits(db, { maxPerTradePct: 10 }, 'test'); // network would allow $10
    grantId = makeGrant(db).grantId;
    activateDirectly(db, grantId);
  });

  /** the size the gate actually evaluated, read back from its own checks */
  const evaluatedSize = (d: { checks: { name: string; detail: string }[] }) =>
    Number(d.checks.find((c) => c.name === 'min_size')!.detail.match(/\$([\d.]+)/)![1]);

  it('clamps a delegated order to the wallet owner\'s headroom, below the network cap', () => {
    const d = evaluateIntent(db, intent(), undefined, undefined, { grantId, hasOpenLot: false });
    // the network would have allowed $10; the owner authorised $5 per trade
    expect(evaluatedSize(d)).toBe(5);
    expect(d.checks.find((c) => c.name === 'delegation_per_trade')?.pass).toBe(true);
    expect(d.checks.find((c) => c.name === 'delegation_headroom')?.pass).toBe(true);
  });

  it('the clamp lands before min_size, so min_size sees the clamped number', () => {
    // $9.80 of a $10 daily cap already spent — $0.20 of headroom is left
    settleSpend(db, grantId, 'spent-a', 'ETHUSDT', 5);
    settleSpend(db, grantId, 'spent-b', 'ETHUSDT', 4.8);
    expect(grantHeadroomUsd(db, grantId)).toBeCloseTo(0.2, 6);

    const d = evaluateIntent(db, intent(), undefined, undefined, { grantId, hasOpenLot: false });
    expect(d.approved).toBe(false);
    // without the clamp this would have been $10 and min_size would have passed
    expect(evaluatedSize(d)).toBeCloseTo(0.2, 6);
    expect(d.checks.find((c) => c.name === 'min_size')?.pass).toBe(false);
  });

  it('a spent-out grant is refused by name, not by a vague size error', () => {
    for (let i = 0; i < 5; i++) settleSpend(db, grantId, `x-${i}`, 'ETHUSDT', 5);
    const d = evaluateIntent(db, intent(), undefined, undefined, { grantId, hasOpenLot: false });
    expect(d.approved).toBe(false);
    expect(d.rejectionReason).toMatch(/delegation_headroom/);
    const c = d.checks.find((x) => x.name === 'delegation_headroom')!;
    expect(c.detail).toMatch(/lifetime \$25\.00\/\$25\.00/);
  });

  it('an exit is never clamped by a spent-out cap — the owner can always get out', () => {
    for (let i = 0; i < 5; i++) settleSpend(db, grantId, `x-${i}`, 'ETHUSDT', 5);
    expect(grantHeadroomUsd(db, grantId)).toBe(0);

    const d = evaluateIntent(db, intent({ side: 'sell' }), undefined, undefined, {
      grantId, hasOpenLot: true,
    }, { isExit: true });
    expect(evaluatedSize(d)).toBe(10); // the network cap, not the exhausted grant cap
    expect(d.checks.find((c) => c.name === 'delegation_exit')?.pass).toBe(true);
    expect(d.checks.some((c) => c.name === 'delegation_headroom')).toBe(false);
  });

  it('a revoked grant still lets an exit through the whole gate', () => {
    db.prepare(`UPDATE delegation_grants SET status = 'revoked' WHERE id = ?`).run(grantId);
    const d = evaluateIntent(db, intent({ side: 'sell' }), undefined, undefined, {
      grantId, hasOpenLot: true,
    }, { isExit: true });
    expect(d.checks.find((c) => c.name === 'delegation_exit_only')?.pass).toBe(true);
    expect(d.approved).toBe(true);
  });

  it('a revoked grant cannot open a new position', () => {
    db.prepare(`UPDATE delegation_grants SET status = 'revoked' WHERE id = ?`).run(grantId);
    const d = evaluateIntent(db, intent(), undefined, undefined, { grantId, hasOpenLot: false });
    expect(d.approved).toBe(false);
    expect(d.rejectionReason).toMatch(/delegation_grant/);
  });

  it('network limits still bind a delegated order — the grant cannot widen them', () => {
    haltNetwork(db, 'operator halt', 'test');
    const d = evaluateIntent(db, intent(), undefined, undefined, { grantId, hasOpenLot: false });
    expect(d.approved).toBe(false);
    expect(d.checks.find((c) => c.name === 'kill_switch')?.pass).toBe(false);
  });

  it('the kill switch also blocks a delegated exit', () => {
    haltNetwork(db, 'operator halt', 'test');
    const d = evaluateIntent(db, intent({ side: 'sell' }), undefined, undefined, {
      grantId, hasOpenLot: true,
    }, { isExit: true });
    expect(d.approved).toBe(false);
    expect(d.checks.find((c) => c.name === 'kill_switch')?.pass).toBe(false);
  });
});

describe('the router guard — the last gate before someone else\'s money moves', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
    side: 'buy' as const,
    notionalUsd: 5,
    maxSlippageBps: 35,
    mode: 'shadow' as const,
    intentId: 'router_guard',
    ...over,
  });

  it('refuses to submit for a grant revoked after risk approval', async () => {
    const db = openTestDb();
    revocationCache.hydrate(db);
    revocationCache.revoke(4242); // the owner revoked while the order was in flight

    const router = new ExecutionRouter(buildAdapters(() => 50_000));
    const r = req({ delegation: { grantId: 4242, isExit: false } });
    const result = await router.execute(router.route(r), r, 50_000);

    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/DELEGATION_REVOKED/);
  });

  it('still lets an exit through — revocation must not trap a position', async () => {
    const db = openTestDb();
    revocationCache.hydrate(db);
    revocationCache.revoke(4242);

    const router = new ExecutionRouter(buildAdapters(() => 50_000));
    const r = req({ side: 'sell' as const, delegation: { grantId: 4242, isExit: true } });
    const result = await router.execute(router.route(r), r, 50_000);
    expect(result.accepted).toBe(true);
  });

  it('does not touch orders with no grant at all', async () => {
    const db = openTestDb();
    revocationCache.hydrate(db);
    const router = new ExecutionRouter(buildAdapters(() => 50_000));
    const r = req();
    const result = await router.execute(router.route(r), r, 50_000);
    expect(result.accepted).toBe(true);
  });
});

describe('the delegation preflight', () => {
  it('fails closed and names every prerequisite', async () => {
    const db = openTestDb();
    revocationCache.hydrate(db);
    const r = await runDelegationPreflight({ db, signer: new NoSigner() }, 'test');
    expect(r.passed).toBe(false);
    const failed = r.checks.filter((c) => c.blocking && !c.pass).map((c) => c.name);
    expect(failed).toContain('delegation_provider');
    expect(failed).toContain('delegation_ceiling');
    expect(failed).toContain('delegation_signer');
    expect(r.blockers.join(' ')).toMatch(/tier 0/);

    // delegation_instruments now passes: a live mapping exists (WETH/USDG on
    // Robinhood Chain), so "a grant could name no tradable pair" is no longer
    // true. Delegation itself remains shut on the three blockers above.
    expect(r.checks.find((c) => c.name === 'delegation_instruments')?.pass).toBe(true);
  });

  it('blocks activation, and records the refusal against the grant', async () => {
    const db = openTestDb();
    tier1Evidence(db);
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
    const { grantId } = makeGrant(db);

    await expect(
      activateGrant(db, new NullDelegationProvider(), grantId, 'ss_x', 'test', new NoSigner()),
    ).rejects.toThrow(/delegation preflight failed/);

    const refused = db
      .prepare(`SELECT * FROM delegation_events WHERE grant_id = ? AND event = 'activation_refused'`)
      .all(grantId) as any[];
    expect(refused).toHaveLength(1);
    expect((db.prepare(`SELECT status FROM delegation_grants WHERE id=?`).get(grantId) as any).status).toBe('pending');
  });

  it('the operator\'s own mode preflight reports delegation but is not blocked by it', async () => {
    const db = openTestDb();
    const r = await runPreflight(
      { db, signer: new NoSigner(), adapters: buildAdapters(() => 1), feedStatus: { binance: { connected: true, stale: false } } },
      'live',
    );
    const ceiling = r.checks.find((c) => c.name === 'delegation_ceiling')!;
    expect(ceiling.pass).toBe(false);
    expect(ceiling.blocking).toBe(false); // otherwise tier 1 could never be earned
    expect(r.blockers.join(' ')).not.toMatch(/delegation/);
  });
});

describe('grant views', () => {
  it('report the caps that apply, not the ones that were asked for', () => {
    const db = openTestDb();
    tier1Evidence(db);
    forceStoredTier(db, 1);
    revocationCache.hydrate(db);
    const { grantId, userId } = makeGrant(db, { perTradeUsd: 10_000, dailyUsd: 10_000, cumulativeUsd: 10_000 });
    activateDirectly(db, grantId);
    const [view] = listGrants(db, userId);
    expect(view.caps.perTradeUsd).toBe(5);
    expect(view.caps.cumulativeUsd).toBe(25);
    expect(view.headroomUsd).toBe(5);
    expect(view.providerBound).toBe(true);
    expect(view.botName).toBe('DELEGATE-1');
    expect(view.expiresAt).toBeLessThan(Date.now() + YEAR);
  });
});
