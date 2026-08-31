import { describe, expect, it } from 'vitest';
import { validateStrategyConfig } from '../src/toolkit/validator.js';

const VALID = {
  version: 1,
  name: 'test bot',
  market: { venue: 'binance', symbols: ['BTCUSDT'], interval: '5m' },
  capital: { initialBalanceUsd: 10000, positionSizePct: 10, maxOpenPositions: 1 },
  entry: { all: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'lt', value: 30 }] },
  exit: { any: [{ kind: 'risk', type: 'takeProfitPct', value: 5 }] },
  risk: { stopLossPct: 3, cooldownMinutes: 15, maxTradesPerDay: 10 },
};

describe('strategy config validator', () => {
  it('accepts a well-formed config', () => {
    const r = validateStrategyConfig(VALID);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects unknown symbols, oversized position, missing risk', () => {
    expect(validateStrategyConfig({ ...VALID, market: { ...VALID.market, symbols: ['DOGEUSDT'] } }).ok).toBe(false);
    expect(validateStrategyConfig({ ...VALID, capital: { ...VALID.capital, positionSizePct: 50 } }).ok).toBe(false);
    const { risk, ...noRisk } = VALID as any;
    expect(validateStrategyConfig(noRisk).ok).toBe(false);
  });

  it('rejects indicator leaves without value or with both value and valueRef', () => {
    const noVal = {
      ...VALID,
      entry: { all: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'lt' }] },
    };
    expect(validateStrategyConfig(noVal).ok).toBe(false);
    const both = {
      ...VALID,
      entry: {
        all: [{
          kind: 'indicator', indicator: 'rsi', period: 14, op: 'lt', value: 30,
          valueRef: { indicator: 'sma', period: 20 },
        }],
      },
    };
    expect(validateStrategyConfig(both).ok).toBe(false);
  });

  it('rejects periodless period-indicators and too-deep trees', () => {
    const noPeriod = {
      ...VALID,
      entry: { all: [{ kind: 'indicator', indicator: 'rsi', op: 'lt', value: 30 }] },
    };
    expect(validateStrategyConfig(noPeriod).ok).toBe(false);

    const leaf = { kind: 'indicator', indicator: 'price', op: 'gt', value: 1 };
    const deep = { all: [{ any: [{ all: [{ not: leaf }] }] }] };
    expect(validateStrategyConfig({ ...VALID, entry: deep }).ok).toBe(false);
  });

  it('rejects cooldown below 1 minute and absurd trade caps', () => {
    expect(validateStrategyConfig({ ...VALID, risk: { ...VALID.risk, cooldownMinutes: 0.2 } }).ok).toBe(false);
    expect(validateStrategyConfig({ ...VALID, risk: { ...VALID.risk, maxTradesPerDay: 5000 } }).ok).toBe(false);
  });

  it('rejects garbage', () => {
    expect(validateStrategyConfig(null).ok).toBe(false);
    expect(validateStrategyConfig('drop table bots').ok).toBe(false);
    expect(validateStrategyConfig({ version: 2 }).ok).toBe(false);
  });
});
