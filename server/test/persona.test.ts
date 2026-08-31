import { describe, expect, it } from 'vitest';
import type { StrategyConfig } from '@punklabz/shared';
import { applyPersonaToConfig, parsePersona, NEUTRAL_TRAITS } from '../src/toolkit/persona.js';

const CFG: StrategyConfig = {
  version: 1,
  name: 'p',
  market: { venue: 'binance', symbols: ['BTCUSDT'], interval: '5m' },
  capital: { initialBalanceUsd: 10000, positionSizePct: 10, maxOpenPositions: 1 },
  entry: { all: [{ kind: 'indicator', indicator: 'rsi', period: 14, op: 'lt', value: 30 }] },
  exit: { any: [{ kind: 'risk', type: 'takeProfitPct', value: 5 }] },
  risk: { stopLossPct: 3, cooldownMinutes: 15, maxTradesPerDay: 10 },
} as StrategyConfig;

describe('persona application', () => {
  it('neutral traits keep the config unchanged', () => {
    const { config } = applyPersonaToConfig(CFG, NEUTRAL_TRAITS);
    expect(config.capital.positionSizePct).toBe(10);
    expect(config.risk.cooldownMinutes).toBe(15);
    expect(config.risk.maxTradesPerDay).toBe(10);
    expect(config.risk.stopLossPct).toBe(3);
  });

  it('max aggression scales size up but never past the schema cap', () => {
    const { config } = applyPersonaToConfig(CFG, { aggression: 1, patience: 0.5, riskTolerance: 0.5 });
    expect(config.capital.positionSizePct).toBe(14); // 10 × 1.4
    const big = { ...CFG, capital: { ...CFG.capital, positionSizePct: 25 } };
    expect(applyPersonaToConfig(big, { aggression: 1, patience: 0.5, riskTolerance: 0.5 }).config.capital.positionSizePct).toBe(25);
  });

  it('patience raises cooldown and lowers trades/day; impatience does the reverse', () => {
    const patient = applyPersonaToConfig(CFG, { aggression: 0.5, patience: 1, riskTolerance: 0.5 }).config;
    expect(patient.risk.cooldownMinutes).toBe(21); // 15 × 1.4
    expect(patient.risk.maxTradesPerDay).toBe(6); // 10 × 0.6
    const twitchy = applyPersonaToConfig(CFG, { aggression: 0.5, patience: 0, riskTolerance: 0.5 }).config;
    expect(twitchy.risk.cooldownMinutes).toBe(9); // 15 × 0.6
    expect(twitchy.risk.maxTradesPerDay).toBe(14); // 10 × 1.4
  });

  it('risk tolerance widens/tightens the stop within bounds', () => {
    expect(applyPersonaToConfig(CFG, { aggression: 0.5, patience: 0.5, riskTolerance: 1 }).config.risk.stopLossPct).toBeCloseTo(4.2);
    expect(applyPersonaToConfig(CFG, { aggression: 0.5, patience: 0.5, riskTolerance: 0 }).config.risk.stopLossPct).toBeCloseTo(1.8);
  });

  it('mods report base and applied for transparency; original config untouched', () => {
    const { mods } = applyPersonaToConfig(CFG, { aggression: 1, patience: 1, riskTolerance: 1 });
    expect(mods.map((m) => m.field).sort()).toEqual(['cooldownMinutes', 'maxTradesPerDay', 'positionSizePct', 'stopLossPct']);
    expect(CFG.capital.positionSizePct).toBe(10); // deep-copied
  });

  it('parsePersona clamps garbage trait values and tolerates bad json', () => {
    const p = parsePersona(JSON.stringify({ intro: 'x', notes: ['a'], traits: { aggression: 99, patience: -5, riskTolerance: 'nope' } }));
    expect(p!.traits).toEqual({ aggression: 1, patience: 0, riskTolerance: 0.5 });
    expect(parsePersona('{broken')).toBeNull();
    expect(parsePersona(null)).toBeNull();
  });
});
