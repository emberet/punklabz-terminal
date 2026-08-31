import { describe, expect, it } from 'vitest';
import type { Candle } from '@punklabz/shared';
import { GridStrategy, GRID_DEFAULTS } from '../src/engine/strategies/grid.js';
import { MomentumStrategy, MOMENTUM_DEFAULTS } from '../src/engine/strategies/momentum.js';
import { MeanReversionStrategy, MEAN_REVERSION_DEFAULTS } from '../src/engine/strategies/meanReversion.js';
import { PumpSniperStrategy, PUMP_SNIPER_DEFAULTS } from '../src/engine/strategies/pumpSniper.js';
import { HerdSentimentStrategy, HERD_DEFAULTS } from '../src/engine/strategies/herdSentiment.js';

// THE EMPTY-CONFIG BUG.
//
// Every house bot ships with config_json = '{}'. The constructors took
// `cfg: Config = DEFAULTS`, and a default parameter only fires on `undefined` —
// so `{}` replaced the defaults wholesale. cfg.interval was undefined, the
// interval guard at the top of onCandle rejected every candle, and five of the
// seven house machines produced nothing for their entire lifetime. No error, no
// log, no signal: 1541 scan passes and zero orders.
//
// These tests are about the SHAPE of the failure, not one strategy: a partial
// config must fill in, and the guards must survive a config that is missing the
// field they read.

const STRATEGIES = [
  ['grid', GridStrategy, GRID_DEFAULTS],
  ['momentum', MomentumStrategy, MOMENTUM_DEFAULTS],
  ['meanReversion', MeanReversionStrategy, MEAN_REVERSION_DEFAULTS],
  ['pumpSniper', PumpSniperStrategy, PUMP_SNIPER_DEFAULTS],
  ['herdSentiment', HerdSentimentStrategy, HERD_DEFAULTS],
] as const;

describe('a stored config of {} must not erase the defaults', () => {
  for (const [name, Strategy, defaults] of STRATEGIES) {
    it(`${name}: {} subscribes to the same thing as no argument at all`, () => {
      const bare = new (Strategy as any)();
      const empty = new (Strategy as any)({});
      expect(empty.subscriptions()).toEqual(bare.subscriptions());
      // and the fields the onCandle guard reads must be present on the config
      // itself — pump-driven strategies hardcode subscriptions(), so the merge
      // is only observable on cfg
      expect((empty as any).cfg.interval).toBe((defaults as any).interval);
      expect((empty as any).cfg.symbols).toEqual((defaults as any).symbols);
    });

    it(`${name}: a partial config overrides only what it names`, () => {
      // every field of the defaults survives except the one overridden
      const key = Object.keys(defaults).find((k) => typeof (defaults as any)[k] === 'number')!;
      const bumped = (defaults as any)[key] + 1;
      const s = new (Strategy as any)({ [key]: bumped });
      const merged = (s as any).cfg;
      expect(merged[key]).toBe(bumped);
      for (const [k, v] of Object.entries(defaults)) {
        if (k === key) continue;
        expect(merged[k], `${name}.${k} should have survived the merge`).toEqual(v);
      }
    });
  }
});

describe('the guard that actually silenced them', () => {
  const candle = (over: Partial<Candle> = {}): Candle => ({
    symbol: 'BTCUSDT', interval: '1m', ts: 1_700_000_000_000,
    o: 100, h: 101, l: 99, c: 100, v: 10, ...over,
  });

  const ctx = (hist: Candle[]) => ({
    botId: 1, now: Date.now(), cashUsd: 10_000, initialBalanceUsd: 10_000, positions: [],
    history: () => hist, mark: () => 100,
    minutesSinceLastTrade: () => Infinity, tradesToday: () => 0,
  }) as any;

  it('an empty-config grid now evaluates its own interval instead of rejecting everything', () => {
    // 60 flat bars is not a setup, so intents may legitimately be zero — what
    // is under test is that the strategy gets PAST the interval guard, which is
    // where it used to stop. A rejected interval can never produce an intent;
    // an accepted one can.
    const hist = Array.from({ length: 60 }, (_, i) => candle({ ts: 1_700_000_000_000 + i * 60_000 }));
    const empty = new GridStrategy({});
    expect(empty.subscriptions().interval).toBe('1m');
    // same shape of answer as a defaulted instance on identical input
    expect(empty.onCandle(ctx(hist), hist[59])).toEqual(new GridStrategy().onCandle(ctx(hist), hist[59]));
  });

  it('a wrong-interval candle is still rejected — the guard was right, its input was not', () => {
    const hist = [candle({ interval: '1h' })];
    expect(new GridStrategy({}).onCandle(ctx(hist), candle({ interval: '1h' }))).toEqual([]);
  });
});
