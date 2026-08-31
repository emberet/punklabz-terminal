import { describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import { evaluateIntent, setCapitalStage, updateLimits } from '../src/live/riskEngine.js';
import type { OrderIntent } from '@punklabz/shared';

// THE OPERATOR FORCE.
//
// A force exists so the execution path can be proven while every strategy is
// quiet. That makes it, by construction, a hole in a gate — so these tests
// pin down EXACTLY how big the hole is. The valuable assertions here are not
// that forcing works; they are the ones proving it does not work on anything
// that protects funds.

function armed(db: DB) {
  db.prepare(`UPDATE live_config SET mode = 'canary', halted = 0 WHERE id = 1`).run();
  setCapitalStage(db, 3, 'test', true);
  updateLimits(db, { confidenceThreshold: 65 }, 'test');
}

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  intentId: 'plz_test_1',
  botId: null,
  instrumentId: 'CRYPTO_SPOT://robinhood/WETH-USDG',
  venue: 'evm:robinhood',
  side: 'buy',
  notionalUsd: 5,
  confidence: 10, // far below any threshold
  reason: 'test',
  ...over,
});

const check = (d: { checks: { name: string; pass: boolean; detail: string }[] }, name: string) =>
  d.checks.find((c) => c.name === name);

describe('an operator force overrides the signal gates', () => {
  it('turns a failing confidence check into a pass that says who overrode it', () => {
    const db = openTestDb();
    armed(db);
    const plain = evaluateIntent(db, intent());
    expect(check(plain, 'confidence')!.pass).toBe(false);

    const forced = evaluateIntent(db, intent({ forcedBy: 'operator:7' }));
    const c = check(forced, 'confidence')!;
    expect(c.pass).toBe(true);
    // the record must name the override, or a reader a month from now sees a
    // 10-confidence trade that apparently passed a 65 threshold
    expect(c.detail).toMatch(/OVERRIDDEN by operator:7/);
    expect(c.detail).toMatch(/10/);
    expect(c.detail).toMatch(/65/);
  });

  it('overrides a negative net edge, and says so', () => {
    const db = openTestDb();
    armed(db);
    const edge = { grossEdgeBps: 5, feeBps: 30, slippageBps: 20, bufferBps: 5, netEdgeBps: -50, edgeModel: 'test' };
    expect(check(evaluateIntent(db, intent(), edge as never), 'net_edge')!.pass).toBe(false);
    const forced = evaluateIntent(db, intent({ forcedBy: 'operator:7' }), edge as never);
    expect(check(forced, 'net_edge')!.pass).toBe(true);
    expect(check(forced, 'net_edge')!.detail).toMatch(/OVERRIDDEN/);
  });

  it('leaves its own fingerprint as a named check', () => {
    const db = openTestDb();
    armed(db);
    expect(check(evaluateIntent(db, intent()), 'operator_force')).toBeUndefined();
    expect(check(evaluateIntent(db, intent({ forcedBy: 'operator:7' })), 'operator_force')!.pass).toBe(true);
  });

  it('is not triggered by an empty or missing actor', () => {
    const db = openTestDb();
    armed(db);
    // a bug that passed `forcedBy: ''` down the chain must not silently force
    for (const forcedBy of ['', undefined]) {
      expect(check(evaluateIntent(db, intent({ forcedBy })), 'confidence')!.pass).toBe(false);
    }
  });
});

describe('an operator force does NOT override the gates that protect funds', () => {
  it('cannot force past the kill switch', () => {
    const db = openTestDb();
    armed(db);
    db.prepare(`UPDATE live_config SET halted = 1, halt_reason = 'test halt' WHERE id = 1`).run();
    const d = evaluateIntent(db, intent({ forcedBy: 'operator:7' }));
    expect(check(d, 'kill_switch')!.pass).toBe(false);
    expect(d.approved).toBe(false);
  });

  it('cannot force past the per-trade notional cap', () => {
    const db = openTestDb();
    armed(db);
    // stage 3 is a $50 cap at 10% per trade = $5; ask for $40
    const d = evaluateIntent(db, intent({ forcedBy: 'operator:7', notionalUsd: 40 }));
    expect(d.approved).toBe(false);
    expect(d.sizeUsd).toBeLessThanOrEqual(5);
  });

  it('cannot force a trade while the mode is simulation', () => {
    const db = openTestDb();
    armed(db);
    db.prepare(`UPDATE live_config SET mode = 'simulation' WHERE id = 1`).run();
    const d = evaluateIntent(db, intent({ forcedBy: 'operator:7' }));
    expect(check(d, 'mode')!.pass).toBe(false);
    expect(d.approved).toBe(false);
  });
});
