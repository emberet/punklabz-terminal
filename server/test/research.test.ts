import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type DB } from '../src/db/db.js';
import {
  BASE_WEIGHTS, COMPONENTS, MAX_ADJUST, componentEvidence, computeWeights,
  confidenceGate, currentWeights, rebuildAgentScores, recomputeWeights, trackRecord,
} from '../src/research/scoring.js';
import { openDirectionClaim, openEdgeClaim, openPrediction, resolvePredictions } from '../src/research/predictions.js';
import { budgetView, costUsd, recordSpend, spendGuard, takeRateLimit } from '../src/research/budget.js';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** a CandleStore stand-in; the resolver only ever asks for history */
const noCandles = { history: () => [] } as any;

function seedResolved(db: DB, claimKind: string, agent: string, rows: { p: number; outcome: 0 | 1 }[]) {
  const stmt = db.prepare(
    `INSERT INTO agent_predictions
       (agent, claim_kind, subject, probability, resolution_rule, resolver, baseline_json,
        horizon_ms, opened_at, resolves_at, resolved_at, outcome, brier)
     VALUES (?, ?, 'BTCUSDT', ?, 'test', 'price_move', '{}', 1, 1, 2, 3, ?, ?)`,
  );
  for (const r of rows) stmt.run(agent, claimKind, r.p, r.outcome, (r.p - r.outcome) ** 2);
}

describe('the LLM/arithmetic boundary', () => {
  it('scoring.ts imports no model client and makes no network call', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/research/scoring.ts'), 'utf8');
    expect(src).not.toMatch(/@anthropic-ai\/sdk/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bhttps?:\/\//);
  });

  it('the resolver decides outcomes without a model either', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/research/predictions.ts'), 'utf8');
    expect(src).not.toMatch(/@anthropic-ai\/sdk/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('confidence weights', () => {
  it('cold start reproduces the hardcoded weights exactly', () => {
    const db = openTestDb();
    const w = currentWeights(db);
    expect(w).toEqual({ strategy: 0.3, regime: 0.25, liquidity: 0.15, cost: 0.15, confirmation: 0.15 });

    // and a composite computed with them equals the old literal expression
    const s = { strategy: 70, regime: 90, liquidity: 95, cost: 75, confirmation: 85 };
    const viaWeights = s.strategy * w.strategy + s.regime * w.regime + s.liquidity * w.liquidity +
      s.cost * w.cost + s.confirmation * w.confirmation;
    const asWritten = s.strategy * 0.3 + s.regime * 0.25 + s.liquidity * 0.15 +
      s.cost * 0.15 + s.confirmation * 0.15;
    expect(viaWeights).toBe(asWritten);
  });

  it('with no evidence the computed weights are the base weights', () => {
    const rows = computeWeights([]);
    for (const r of rows) {
      expect(r.weight).toBeCloseTo(BASE_WEIGHTS[r.component], 12);
      expect(r.shrunkSkill).toBe(0);
    }
  });

  it('always sums to 1 and never moves a weight more than ±50%, for any input', () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 4_294_967_296);

    for (let trial = 0; trial < 500; trial++) {
      const evidence = COMPONENTS.filter(() => rand() < 0.8).map((component) => ({
        component,
        resolvedN: Math.floor(rand() * 4000),
        meanBrier: rand(), // the full legal range, including terrible
      }));
      const rows = computeWeights(evidence);

      const sum = rows.reduce((s, r) => s + r.weight, 0);
      expect(sum).toBeCloseTo(1, 10);
      for (const r of rows) {
        expect(Number.isFinite(r.weight)).toBe(true);
        expect(r.weight).toBeGreaterThan(0);
        // pre-normalisation bound: base * (1 ± 0.5). Normalisation can only
        // rescale the set, so check the ratio against the base ratio.
        const ratio = r.weight / BASE_WEIGHTS[r.component];
        const minRatio = (1 - MAX_ADJUST) / (1 + MAX_ADJUST);
        const maxRatio = (1 + MAX_ADJUST) / (1 - MAX_ADJUST);
        expect(ratio).toBeGreaterThanOrEqual(minRatio - 1e-9);
        expect(ratio).toBeLessThanOrEqual(maxRatio + 1e-9);
      }
    }
  });

  it('is deterministic — the same evidence always yields the same weights', () => {
    const evidence = [
      { component: 'strategy' as const, resolvedN: 120, meanBrier: 0.18 },
      { component: 'regime' as const, resolvedN: 40, meanBrier: 0.31 },
    ];
    expect(JSON.stringify(computeWeights(evidence))).toBe(JSON.stringify(computeWeights(evidence)));
  });

  it('a good forecaster gains weight and a bad one loses it', () => {
    const good = computeWeights([{ component: 'strategy', resolvedN: 400, meanBrier: 0.05 }]);
    const bad = computeWeights([{ component: 'strategy', resolvedN: 400, meanBrier: 0.45 }]);
    expect(good.find((r) => r.component === 'strategy')!.shrunkSkill).toBeGreaterThan(0);
    expect(bad.find((r) => r.component === 'strategy')!.shrunkSkill).toBeLessThan(0);

    // and after normalisation the good forecaster holds a larger share of the
    // score than the bad one does
    const share = (rows: typeof good) => rows.find((r) => r.component === 'strategy')!.weight;
    expect(share(good)).toBeGreaterThan(BASE_WEIGHTS.strategy);
    expect(share(bad)).toBeLessThan(share(good));
  });

  it('a coin-flip Brier of 0.25 is exactly zero skill, however much evidence backs it', () => {
    // this is the line that keeps the loop honest: an agent that is no better
    // than guessing must gain nothing, not "a bit less than a good one"
    const rows = computeWeights([{ component: 'strategy', resolvedN: 10_000, meanBrier: 0.25 }]);
    const strategy = rows.find((r) => r.component === 'strategy')!;
    expect(strategy.shrunkSkill).toBeCloseTo(0, 12);
    expect(strategy.weight).toBeCloseTo(BASE_WEIGHTS.strategy, 12);
  });

  it('a Brier just under a coin flip earns only a sliver of weight', () => {
    const rows = computeWeights([{ component: 'strategy', resolvedN: 10_000, meanBrier: 0.24 }]);
    const strategy = rows.find((r) => r.component === 'strategy')!;
    expect(strategy.weight).toBeGreaterThan(BASE_WEIGHTS.strategy);
    expect(strategy.weight - BASE_WEIGHTS.strategy).toBeLessThan(0.01);
  });

  it('small samples are shrunk toward the base weight', () => {
    const few = computeWeights([{ component: 'strategy', resolvedN: 2, meanBrier: 0.0 }]);
    const many = computeWeights([{ component: 'strategy', resolvedN: 2000, meanBrier: 0.0 }]);
    const f = Math.abs(few.find((r) => r.component === 'strategy')!.shrunkSkill);
    const m = Math.abs(many.find((r) => r.component === 'strategy')!.shrunkSkill);
    expect(f).toBeLessThan(m);
    expect(f).toBeLessThan(0.1);
  });

  it('only resolved, non-void predictions become evidence', () => {
    const db = openTestDb();
    seedResolved(db, 'direction', 'scanner:momentum', [{ p: 0.9, outcome: 1 }, { p: 0.8, outcome: 1 }]);
    // an unresolved row and a voided row must not count
    db.prepare(
      `INSERT INTO agent_predictions (agent, claim_kind, subject, probability, resolution_rule, resolver,
         baseline_json, horizon_ms, opened_at, resolves_at)
       VALUES ('x','direction','BTCUSDT',0.99,'t','price_move','{}',1,1,2)`,
    ).run();
    db.prepare(
      `INSERT INTO agent_predictions (agent, claim_kind, subject, probability, resolution_rule, resolver,
         baseline_json, horizon_ms, opened_at, resolves_at, resolved_at, brier, void_reason)
       VALUES ('x','direction','BTCUSDT',0.99,'t','price_move','{}',1,1,2,3,0.0001,'no mark')`,
    ).run();

    const ev = componentEvidence(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ component: 'strategy', resolvedN: 2 });
  });

  it('recompute writes a new version only when a weight actually moves', () => {
    const db = openTestDb();
    expect(recomputeWeights(db)).toHaveLength(5);
    expect((db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as any).v).toBe(1);

    seedResolved(db, 'direction', 'a', Array.from({ length: 200 }, () => ({ p: 0.9 as number, outcome: 1 as const })));
    recomputeWeights(db);
    const v2 = (db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as any).v;
    expect(v2).toBe(2);
    expect(currentWeights(db).strategy).toBeGreaterThan(0.3);

    recomputeWeights(db); // nothing new resolved
    expect((db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as any).v).toBe(v2);
  });

  it('every stored weight row carries the inputs it was computed from', () => {
    const db = openTestDb();
    seedResolved(db, 'direction', 'a', Array.from({ length: 60 }, () => ({ p: 0.9 as number, outcome: 1 as const })));
    recomputeWeights(db);
    const rows = db.prepare(`SELECT inputs_json FROM confidence_weights WHERE version = 2`).all() as any[];
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(JSON.parse(r.inputs_json)).toHaveProperty('evidence');
  });
});

describe('predictions', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('freezes the resolution rule and baseline at open', () => {
    const id = openDirectionClaim(db, 'scanner:momentum', 'BTCUSDT', 50_000, 'buy', 0.8)!;
    const row = db.prepare(`SELECT * FROM agent_predictions WHERE id = ?`).get(id) as any;
    expect(row.resolution_rule).toMatch(/closes above 50000\.000000/);
    expect(JSON.parse(row.baseline_json).price).toBe(50_000);
    expect(row.resolved_at).toBeNull();
  });

  it('refuses to open a claim it could never settle', () => {
    expect(openDirectionClaim(db, 'a', 'BTCUSDT', 0, 'buy', 0.8)).toBeNull();
    expect(openEdgeClaim(db, 'a', 'BTCUSDT', 0, 40, 0.8)).toBeNull();
    expect(openEdgeClaim(db, 'a', 'BTCUSDT', 50_000, NaN, 0.8)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) n FROM agent_predictions`).get()).toEqual({ n: 0 });
  });

  it('settles a correct call and scores it', () => {
    openDirectionClaim(db, 'scanner:momentum', 'BTCUSDT', 50_000, 'buy', 0.8, -1);
    const r = resolvePredictions(db, noCandles, () => 51_000);
    expect(r.resolved).toBe(1);
    const row = db.prepare(`SELECT * FROM agent_predictions`).get() as any;
    expect(row.outcome).toBe(1);
    expect(row.brier).toBeCloseTo(0.04, 6); // (0.8 - 1)^2
  });

  it('settles a wrong call against the agent, not quietly', () => {
    openDirectionClaim(db, 'scanner:momentum', 'BTCUSDT', 50_000, 'buy', 0.9, -1);
    resolvePredictions(db, noCandles, () => 49_000);
    const row = db.prepare(`SELECT * FROM agent_predictions`).get() as any;
    expect(row.outcome).toBe(0);
    expect(row.brier).toBeCloseTo(0.81, 6);
  });

  it('VOIDS rather than guesses when there is no mark to settle against', () => {
    openDirectionClaim(db, 'scanner:momentum', 'BTCUSDT', 50_000, 'buy', 0.9, -1);
    const r = resolvePredictions(db, noCandles, () => null);
    expect(r.voided).toBe(1);
    expect(r.resolved).toBe(0);
    const row = db.prepare(`SELECT * FROM agent_predictions`).get() as any;
    expect(row.outcome).toBeNull();
    expect(row.brier).toBeNull();
    expect(row.void_reason).toMatch(/no mark available/);
    // and a void contributes nothing to the score
    expect(componentEvidence(db)).toHaveLength(0);
  });

  it('does not settle a claim before its horizon', () => {
    openDirectionClaim(db, 'a', 'BTCUSDT', 50_000, 'buy', 0.8, 3_600_000);
    const r = resolvePredictions(db, noCandles, () => 60_000);
    expect(r.resolved).toBe(0);
    expect((db.prepare(`SELECT resolved_at FROM agent_predictions`).get() as any).resolved_at).toBeNull();
  });

  it('an edge claim is settled on the size of the move, in either direction', () => {
    openEdgeClaim(db, 'bot:1', 'BTCUSDT', 50_000, 100, 0.7, null, -1); // needs 100bps = 1%
    resolvePredictions(db, noCandles, () => 49_400);               // moved 1.2% down
    const row = db.prepare(`SELECT * FROM agent_predictions`).get() as any;
    expect(row.outcome).toBe(1);
    expect(JSON.parse(row.outcome_json).movedBps).toBeCloseTo(120, 0);
  });

  it('an unknown resolver voids instead of inventing an answer', () => {
    openPrediction(db, {
      agent: 'a', claimKind: 'regime_persists', subject: 'BTCUSDT', probability: 0.7,
      resolutionRule: 'x', resolver: 'not_a_real_resolver', baseline: { symbol: 'BTCUSDT' }, horizonMs: -1,
    });
    const r = resolvePredictions(db, noCandles, () => 50_000);
    expect(r.voided).toBe(1);
    expect((db.prepare(`SELECT void_reason FROM agent_predictions`).get() as any).void_reason)
      .toMatch(/no resolver named/);
  });

  it('resolving updates the scores and can move the weights', () => {
    for (let i = 0; i < 120; i++) {
      openDirectionClaim(db, 'scanner:momentum', 'BTCUSDT', 50_000, 'buy', 0.95, -1);
    }
    const r = resolvePredictions(db, noCandles, () => 51_000);
    expect(r.resolved).toBe(120);
    expect(r.weightsMoved).toBe(true);
    expect(currentWeights(db).strategy).toBeGreaterThan(0.3);
  });
});

describe('the public track record', () => {
  it('reports the bad quarters too, against a coin-flip baseline', () => {
    const db = openTestDb();
    seedResolved(db, 'direction', 'GOOD', Array.from({ length: 30 }, () => ({ p: 0.9 as number, outcome: 1 as const })));
    seedResolved(db, 'direction', 'BAD', Array.from({ length: 30 }, () => ({ p: 0.9 as number, outcome: 0 as const })));
    rebuildAgentScores(db);

    const record = trackRecord(db);
    const good = record.find((r) => r.agent === 'GOOD')!;
    const bad = record.find((r) => r.agent === 'BAD')!;
    expect(good.beatsBaseline).toBe(true);
    expect(bad.beatsBaseline).toBe(false);
    expect(bad.hitRate).toBe(0);
  });

  it('caps stated confidence until the claim kind has a real record', () => {
    const db = openTestDb();
    expect(confidenceGate(db, 'INTERN', 'regime_persists', 95)).toBe(60);

    // 10 resolved is not enough evidence, however good it looks
    seedResolved(db, 'regime_persists', 'INTERN', Array.from({ length: 10 }, () => ({ p: 0.9 as number, outcome: 1 as const })));
    rebuildAgentScores(db);
    expect(confidenceGate(db, 'INTERN', 'regime_persists', 95)).toBe(60);

    // 30 resolved and beating a coin flip earns the right to sound sure
    seedResolved(db, 'regime_persists', 'INTERN', Array.from({ length: 20 }, () => ({ p: 0.9 as number, outcome: 1 as const })));
    rebuildAgentScores(db);
    expect(confidenceGate(db, 'INTERN', 'regime_persists', 95)).toBe(95);

    // being consistently wrong takes it away again
    seedResolved(db, 'regime_persists', 'INTERN', Array.from({ length: 200 }, () => ({ p: 0.9 as number, outcome: 0 as const })));
    rebuildAgentScores(db);
    expect(confidenceGate(db, 'INTERN', 'regime_persists', 95)).toBe(60);
  });
});

describe('spend control', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('the forum cooldown survives a restart', () => {
    // the bug this replaces lived in a module-level `let`, which a crash loop reset
    const first = takeRateLimit(db, 'forum:autopost', { cooldownMs: 600_000 });
    expect(first.allowed).toBe(true);

    const second = takeRateLimit(db, 'forum:autopost', { cooldownMs: 600_000 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/cooling down/);

    // "restarting" the process changes nothing: the state is in the database
    const afterRestart = takeRateLimit(db, 'forum:autopost', { cooldownMs: 600_000 });
    expect(afterRestart.allowed).toBe(false);
  });

  it('enforces a rolling window cap on top of the cooldown', () => {
    const spec = { cooldownMs: 0, maxInWindow: 3, windowMs: 86_400_000 };
    expect(takeRateLimit(db, 'intern:publish', spec).allowed).toBe(true);
    expect(takeRateLimit(db, 'intern:publish', spec).allowed).toBe(true);
    expect(takeRateLimit(db, 'intern:publish', spec).allowed).toBe(true);
    const fourth = takeRateLimit(db, 'intern:publish', spec);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toMatch(/3\/3 used/);
  });

  it('different keys do not share a limit', () => {
    expect(takeRateLimit(db, 'a', { cooldownMs: 600_000 }).allowed).toBe(true);
    expect(takeRateLimit(db, 'b', { cooldownMs: 600_000 }).allowed).toBe(true);
  });

  it('the monthly cap is measured, not estimated, and stops spending at the line', () => {
    expect(spendGuard(db, 'forum').allowed).toBe(true);

    // book real usage until the configured cap is reached
    const perCall = costUsd(50_000, 5_000);
    const calls = Math.ceil(config.llmBudgetUsd / perCall);
    for (let i = 0; i < calls; i++) recordSpend(db, 'forum', 50_000, 5_000);

    const verdict = spendGuard(db, 'forum');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/monthly LLM budget reached/);
    expect(budgetView(db).spentUsd).toBeGreaterThanOrEqual(config.llmBudgetUsd);
    expect(budgetView(db).byCaller[0].calls).toBe(calls);
  });

  it('the guard fails closed when the ledger cannot be read', () => {
    db.exec(`DROP TABLE llm_budget`);
    const verdict = spendGuard(db, 'forum');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/unreadable/);
  });
});
