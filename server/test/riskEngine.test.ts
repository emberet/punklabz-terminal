import { beforeEach, describe, expect, it } from 'vitest';
import type { OrderIntent } from '@punklabz/shared';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  evaluateIntent, getLiveConfig, haltNetwork, resumeNetwork,
  setCapitalStage, setLiveMode, updateLimits,
} from '../src/live/riskEngine.js';
import { toMicro } from '../src/money.js';

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

  it('canary and live modes are structurally refused (no signer exists)', () => {
    expect(() => setLiveMode(db, 'canary', 'test')).toThrow(/REFUSED/);
    expect(() => setLiveMode(db, 'live', 'test')).toThrow(/REFUSED/);
    expect(getLiveConfig(db).mode).toBe('simulation');
  });

  it('capital stages above 1 are refused without canary evidence', () => {
    expect(() => setCapitalStage(db, 2, 'test')).toThrow(/REFUSED/);
    setCapitalStage(db, 1, 'test');
    expect(getLiveConfig(db).capitalStage).toBe(1);
  });

  it('shadow at stage 0 rejects on capital; stage 1 approves within caps', () => {
    setLiveMode(db, 'shadow', 'test');
    const d0 = evaluateIntent(db, intent());
    expect(d0.approved).toBe(false);
    expect(d0.checks.find((c) => c.name === 'capital_stage')?.pass).toBe(false);

    setCapitalStage(db, 1, 'test');
    const d1 = evaluateIntent(db, intent({ notionalUsd: 10 }));
    expect(d1.approved).toBe(false); // $10 request capped to 5% of $5 = $0.25 < min size
    const d2 = evaluateIntent(db, intent({ notionalUsd: 10 }));
    expect(d2.checks.find((c) => c.name === 'min_size')?.pass).toBe(false);
    void d2;
    // widen per-trade cap to make a viable size
    updateLimits(db, { maxPerTradePct: 10, minCashReservePct: 10 }, 'test');
    const d3 = evaluateIntent(db, intent({ notionalUsd: 0.6 }));
    expect(d3.approved).toBe(true);
    expect(d3.sizeUsd).toBeLessThanOrEqual(0.6);
  });

  it('confidence below threshold rejects', () => {
    setLiveMode(db, 'shadow', 'test');
    setCapitalStage(db, 1, 'test');
    const d = evaluateIntent(db, intent({ confidence: 50 }));
    expect(d.approved).toBe(false);
    expect(d.checks.find((c) => c.name === 'confidence')?.pass).toBe(false);
  });

  it('kill switch blocks everything until resumed', () => {
    setLiveMode(db, 'shadow', 'test');
    setCapitalStage(db, 1, 'test');
    updateLimits(db, { maxPerTradePct: 10, minCashReservePct: 10 }, 'test');
    haltNetwork(db, 'test halt', 'test');
    expect(evaluateIntent(db, intent({ notionalUsd: 0.6 })).approved).toBe(false);
    resumeNetwork(db, 'test');
    expect(evaluateIntent(db, intent({ notionalUsd: 0.6 })).approved).toBe(true);
  });

  it('daily-loss breach rejects new entries', () => {
    setLiveMode(db, 'shadow', 'test');
    setCapitalStage(db, 1, 'test');
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
    setCapitalStage(db, 1, 'test');
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
