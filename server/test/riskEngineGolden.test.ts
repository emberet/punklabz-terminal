import { describe, expect, it } from 'vitest';
import type { OrderIntent } from '@punklabz/shared';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  evaluateIntent, getLiveConfig, setCapitalStage, setLiveMode, stageCapUsd,
} from '../src/live/riskEngine.js';

// THE REGRESSION SIGNAL FOR THE DELEGATION HOOK.
//
// evaluateIntent() is the one function every order in this system passes
// through, and the delegation clamp was inserted into the middle of it. The
// failure mode is quiet: non-delegated orders approve at a slightly different
// size, nothing throws, and the ledger disagrees with the venue days later.
//
// So: drive randomised non-delegated intents through the gate and assert the
// approved size still equals the pre-delegation formula exactly — computed here
// independently of the implementation — and that no delegation check ever
// appears on an order that has no grant.

/** deterministic PRNG so a failure is reproducible from the seed alone */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

function seedDb(): DB {
  const db = openTestDb();
  db.prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('g@x.com','g',1)`).run();
  db.prepare(`INSERT INTO bots (name, kind, strategy_type, config_json, created_at) VALUES ('G','house','momentum','{}',1)`).run();
  setLiveMode(db, 'shadow', 'golden');
  setCapitalStage(db, 1, 'golden');
  return db;
}

describe('evaluateIntent is unchanged for orders with no delegation grant', () => {
  it('approved size still equals min(requested, maxPerTradePct of stage cap) across 200 random intents', () => {
    const db = seedDb();
    const cfg = getLiveConfig(db);
    const stageCap = stageCapUsd(cfg.capitalStage);
    const maxPerTrade = (stageCap * cfg.limits.maxPerTradePct) / 100;
    const rand = rng(20260831);

    for (let i = 0; i < 200; i++) {
      const notionalUsd = Number((rand() * 250).toFixed(6));
      const intent: OrderIntent = {
        intentId: `golden_${i}`,
        botId: rand() < 0.15 ? null : 1,
        instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
        venue: 'paper',
        side: rand() < 0.5 ? 'buy' : 'sell',
        notionalUsd,
        confidence: Math.floor(rand() * 100),
        reason: 'golden',
      };

      const d = evaluateIntent(db, intent);

      // the formula as it stood before the delegation clamp existed
      const expectedSize = Math.min(notionalUsd, maxPerTrade);
      if (d.approved) {
        expect(d.sizeUsd, `intent ${i} (notional ${notionalUsd})`).toBe(expectedSize);
      } else {
        expect(d.sizeUsd).toBe(0);
      }

      // and the size the checks were evaluated against is that same number
      const minSize = d.checks.find((c) => c.name === 'min_size')!;
      expect(minSize.pass).toBe(expectedSize >= 0.5);

      // nothing delegation-shaped may appear on an order with no grant
      expect(d.checks.some((c) => c.name.startsWith('delegation'))).toBe(false);
    }
  });

  it('passing the delegation argument as undefined is identical to omitting it', () => {
    const db = seedDb();
    const rand = rng(7);
    for (let i = 0; i < 50; i++) {
      const base = {
        botId: 1,
        instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
        venue: 'paper',
        side: 'buy' as const,
        notionalUsd: Number((rand() * 40).toFixed(6)),
        confidence: Math.floor(rand() * 100),
        reason: 'golden',
      };
      const a = evaluateIntent(db, { ...base, intentId: `omit_${i}` });
      const b = evaluateIntent(db, { ...base, intentId: `explicit_${i}` }, undefined, undefined, undefined);
      expect(JSON.stringify(b.checks)).toBe(JSON.stringify(a.checks));
      expect(b.sizeUsd).toBe(a.sizeUsd);
      expect(b.approved).toBe(a.approved);
    }
  });

  it('the account-scoped path is also untouched', () => {
    const db = seedDb();
    const acct = db.prepare(`SELECT id FROM execution_accounts LIMIT 1`).get() as { id: number };
    const intent: OrderIntent = {
      intentId: 'acct_scoped', botId: 1, instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
      venue: 'paper', side: 'buy', notionalUsd: 0.2, confidence: 99, reason: 'golden',
    };
    const d = evaluateIntent(db, intent, undefined, acct.id);
    expect(d.checks.some((c) => c.name.startsWith('delegation'))).toBe(false);
    expect(d.sizeUsd).toBe(0); // rejected on min_size, exactly as before
  });
});

describe('module load order', () => {
  // riskEngine and delegationPolicy import each other. That is safe only while
  // both sides are hoisted function declarations used inside call bodies. If
  // someone converts one to a const arrow, one of these two orders throws
  // "Cannot access '…' before initialization" and this test catches it.
  it('works whichever module is imported first', async () => {
    const policyFirst = await import('../src/live/delegation/delegationPolicy.js');
    const engineSecond = await import('../src/live/riskEngine.js');
    expect(typeof policyFirst.evaluateDelegation).toBe('function');
    expect(typeof engineSecond.evaluateIntent).toBe('function');

    const db = openTestDb();
    expect(() => policyFirst.delegationCeiling(db)).not.toThrow();
    expect(() =>
      engineSecond.evaluateIntent(db, {
        intentId: 'load_order', botId: null, instrumentId: 'x', venue: 'paper',
        side: 'buy', notionalUsd: 1, confidence: 99, reason: 'load order',
      }),
    ).not.toThrow();
  });
});
