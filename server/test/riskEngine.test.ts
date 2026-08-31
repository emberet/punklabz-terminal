import { beforeEach, describe, expect, it } from 'vitest';
import type { OrderIntent } from '@punklabz/shared';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  evaluateIntent, getLiveConfig, haltNetwork,
  setCapitalStage, setLiveMode, updateLimits,
} from '../src/live/riskEngine.js';
import { toMicro } from '../src/money.js';
import { accountForMode, recordFunding } from '../src/live/accounts.js';

function setTestStage(db: DB, stage: number) {
  getLiveConfig(db);
  db.prepare(`UPDATE live_config SET capital_stage=? WHERE id=1`).run(stage);
}

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intentId: `t_${Math.random().toString(36).slice(2)}`,
    botId: 1,
    instrumentId: 'CRYPTO_SPOT://binance/BTCUSDT',
    venue: 'paper',
    side: 'buy',
    notionalUsd: 1,
    confidence: 95,
    reason: 'test',
    ...over,
  };
}

describe('risk engine', () => {
  let db: DB;

  beforeEach(() => {
    db = openTestDb();
    db.prepare(`INSERT INTO users (email, display_name, created_at) VALUES ('r@x.com','r',1)`).run();
    db.prepare(`INSERT INTO bots (name, kind, strategy_type, config_json, created_at) VALUES ('T','house','momentum','{}',1)`).run();
  });

  it('simulation mode rejects everything', () => {
    const d = evaluateIntent(db, intent());
    expect(d.approved).toBe(false);
    expect(d.checks.find((c) => c.name === 'mode')?.pass).toBe(false);
  });

  it('canary and live require a passing preflight (which today fails closed)', () => {
    expect(() => setLiveMode(db, 'canary', 'test')).toThrow(/preflight result is required/);
    expect(() => setLiveMode(db, 'live', 'test', { passed: false, blockers: ['signer: none'] }))
      .toThrow(/preflight failed/);
    expect(getLiveConfig(db).mode).toBe('simulation');
  });

  it('capital stages above 1 need real fills as evidence', () => {
    const account = accountForMode(db, 'canary', 'evm:robinhood');
    recordFunding(db, account.id, [{ asset: 'USDG', qty: 20, txRef: '0xfunding', logIndex: 0 }], 'test');
    db.prepare(
      `INSERT INTO reconciliation_runs (execution_account_id, started_at, completed_at, status, actor)
       VALUES (?, 1, 2, 'clean', 'test')`,
    ).run(account.id);
    setCapitalStage(db, 1, 'test');
    expect(getLiveConfig(db).capitalStage).toBe(1);
    expect(() => setCapitalStage(db, 2, 'test')).toThrow(/clean fill/);
  });

  it('shadow at stage 0 rejects on capital; stage 1 approves within caps', () => {
    setLiveMode(db, 'shadow', 'test');
    const d0 = evaluateIntent(db, intent());
    expect(d0.approved).toBe(false);
    expect(d0.checks.find((c) => c.name === 'capital_stage')?.pass).toBe(false);

    setTestStage(db, 1);
    const d1 = evaluateIntent(db, intent({ notionalUsd: 10 }));
    expect(d1.approved).toBe(true); // $10 request is capped to 10% of $5 = the $0.50 minimum
    expect(d1.sizeUsd).toBe(0.5);
    const d2 = evaluateIntent(db, intent({ notionalUsd: 10 }));
    expect(d2.checks.find((c) => c.name === 'min_size')?.pass).toBe(true);
    void d2;
    // widen per-trade cap to make a viable size
    updateLimits(db, { maxPerTradePct: 10, minCashReservePct: 10 }, 'test');
    const d3 = evaluateIntent(db, intent({ notionalUsd: 0.6 }));
    expect(d3.approved).toBe(true);
    expect(d3.sizeUsd).toBeLessThanOrEqual(0.6);
  });

  it('confidence below threshold rejects', () => {
    setLiveMode(db, 'shadow', 'test');
    setTestStage(db, 1);
    const d = evaluateIntent(db, intent({ confidence: 50 }));
    expect(d.approved).toBe(false);
    expect(d.checks.find((c) => c.name === 'confidence')?.pass).toBe(false);
  });

  it('kill switch blocks everything until resumed', () => {
    setLiveMode(db, 'shadow', 'test');
    setTestStage(db, 1);
    updateLimits(db, { maxPerTradePct: 10, minCashReservePct: 10 }, 'test');
    haltNetwork(db, 'test halt', 'test');
    expect(evaluateIntent(db, intent({ notionalUsd: 0.6 })).approved).toBe(false);
    db.prepare(`UPDATE live_config SET halted=0, halt_reason=NULL WHERE id=1`).run();
    expect(evaluateIntent(db, intent({ notionalUsd: 0.6 })).approved).toBe(true);
  });

  it('an exit may relax entry gates but never bypasses the kill switch', () => {
    setLiveMode(db, 'shadow', 'test');
    setTestStage(db, 1);
    const exit = intent({ side: 'sell', notionalUsd: 1, confidence: 1 });
    const losingEdge = {
      grossEdgeBps: 1, feeBps: 10, slippageBps: 10, bufferBps: 10, netEdgeBps: -29, edgeModel: 'test',
    };
    const allowed = evaluateIntent(db, exit, losingEdge, undefined, undefined, { isExit: true });
    expect(allowed.approved).toBe(true);
    expect(allowed.checks.find((c) => c.name === 'exit')?.pass).toBe(true);

    haltNetwork(db, 'operator halt', 'test');
    const halted = evaluateIntent(db, { ...exit, intentId: `${exit.intentId}-halted` }, losingEdge,
      undefined, undefined, { isExit: true });
    expect(halted.approved).toBe(false);
    expect(halted.checks.find((c) => c.name === 'kill_switch')?.pass).toBe(false);
  });

  it('daily-loss breach rejects new entries', () => {
    setLiveMode(db, 'shadow', 'test');
    setTestStage(db, 1);
    updateLimits(db, { maxPerTradePct: 10, minCashReservePct: 10, maxDailyLossPct: 5 }, 'test');
    // book a shadow loss of $1 today (> 5% of $5)
    db.prepare(
      `INSERT INTO live_ledger (bot_id, instrument_id, venue, side, qty, expected_price, executed_price, realized_pnl_micro, mode, ts)
       VALUES (1, 'CRYPTO_SPOT://binance/BTCUSDT', 'shadow', 'sell', 1, 100, 99, ?, 'shadow', ?)`,
    ).run(toMicro(-1), Date.now());
    const d = evaluateIntent(db, intent({ notionalUsd: 0.6 }));
    expect(d.approved).toBe(false);
    expect(d.checks.find((c) => c.name === 'daily_loss')?.pass).toBe(false);
  });

  it('drawdown breach trips the automatic circuit breaker', () => {
    setLiveMode(db, 'shadow', 'test');
    setTestStage(db, 1);
    updateLimits(db, { maxTotalDrawdownPct: 10, maxDailyLossPct: 10, maxPerTradePct: 10, minCashReservePct: 10 }, 'test');
    // stage cap $5; lose $1 => 20% drawdown ≥ 10%
    db.prepare(
      `INSERT INTO live_ledger (bot_id, instrument_id, venue, side, qty, expected_price, executed_price, realized_pnl_micro, mode, ts)
       VALUES (1, 'CRYPTO_SPOT://binance/BTCUSDT', 'shadow', 'sell', 1, 100, 99, ?, 'shadow', ?)`,
    ).run(toMicro(-1), Date.now() - 90_000_000); // yesterday: dodge daily-loss check
    const d = evaluateIntent(db, intent({ notionalUsd: 0.6 }));
    expect(d.approved).toBe(false);
    expect(getLiveConfig(db).halted).toBe(true);
    expect(getLiveConfig(db).haltReason).toMatch(/circuit breaker/);
  });

  it('operator limit updates are clamped: leverage stays 1, capital ≤ 100', () => {
    const limits = updateLimits(db, { maxPerTradePct: 99 } as any, 'test');
    expect(limits.maxPerTradePct).toBe(10);
    expect(limits.leverageMax).toBe(1);
    expect(limits.totalCapitalUsd).toBeLessThanOrEqual(100);
  });
});
