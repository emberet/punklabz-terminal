import type { DB } from '../db/db.js';

// THE FEEDBACK LOOP.
//
// This file imports no Anthropic SDK and makes no network call, and a test
// asserts that. The reason is the whole design: an agent's narration is a
// proposal, and only arithmetic on resolved outcomes is allowed to move what
// the network believes. If a model could write its own weights, the confidence
// score would measure persuasion instead of accuracy.
//
// Cold start is deliberately a no-op. With zero resolved predictions the
// shrunk skill is 0, every weight equals its base, and the composite score is
// bit-identical to what the network computed before this file existed.

export const COMPONENTS = ['strategy', 'regime', 'liquidity', 'cost', 'confirmation'] as const;
export type Component = (typeof COMPONENTS)[number];

/** the weights in force before any evidence existed */
export const BASE_WEIGHTS: Record<Component, number> = {
  strategy: 0.3,
  regime: 0.25,
  liquidity: 0.15,
  cost: 0.15,
  confirmation: 0.15,
};

/** how much evidence before a component's score is taken at face value */
export const SHRINK_N = 40;
/** the hard bound: evidence can move a weight by at most ±50% of its base */
export const MAX_ADJUST = 0.5;
/**
 * The Brier score of a forecaster who always says "50%". This is the reference
 * skill is measured against, and it is the whole reason the loop is honest: an
 * agent must beat a coin flip to gain weight, not merely score a smallish
 * number. (Scoring against 0.5 instead would hand +0.5 skill to a Brier of
 * 0.25 — i.e. reward a coin flip — and the weights would drift on noise.)
 */
export const COIN_FLIP_BRIER = 0.25;

export interface ComponentEvidence {
  component: Component;
  resolvedN: number;
  meanBrier: number;
}

export interface WeightRow {
  component: Component;
  baseWeight: number;
  weight: number;
  shrunkSkill: number;
  resolvedN: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * PURE. Brier → skill → shrunk skill → bounded weight → normalised.
 *
 * Skill is the Brier Skill Score against a coin flip: 1 − B/0.25. Perfect is
 * +1, a coin flip is exactly 0, and anything worse is negative. Better than a
 * coin flip earns weight; worse than one loses it.
 */
export function computeWeights(evidence: ComponentEvidence[]): WeightRow[] {
  const byComponent = new Map(evidence.map((e) => [e.component, e]));

  const raw = COMPONENTS.map((component) => {
    const ev = byComponent.get(component);
    const base = BASE_WEIGHTS[component];
    if (!ev || ev.resolvedN <= 0) {
      return { component, baseWeight: base, weight: base, shrunkSkill: 0, resolvedN: 0 };
    }
    const skill = clamp(1 - ev.meanBrier / COIN_FLIP_BRIER, -1, 1);
    const shrunkSkill = skill * (ev.resolvedN / (ev.resolvedN + SHRINK_N));
    return {
      component,
      baseWeight: base,
      weight: base * (1 + MAX_ADJUST * shrunkSkill),
      shrunkSkill,
      resolvedN: ev.resolvedN,
    };
  });

  const total = raw.reduce((s, r) => s + r.weight, 0);
  if (total <= 0) {
    // cannot happen with the bounds above, but a zero divide here would produce
    // NaN confidence on every order in the system
    return COMPONENTS.map((component) => ({
      component, baseWeight: BASE_WEIGHTS[component], weight: BASE_WEIGHTS[component],
      shrunkSkill: 0, resolvedN: 0,
    }));
  }
  return raw.map((r) => ({ ...r, weight: r.weight / total }));
}

/**
 * Which component a claim kind is evidence about. A prediction that does not
 * map to a component still scores the agent — it just doesn't move a weight.
 */
const CLAIM_TO_COMPONENT: Record<string, Component | undefined> = {
  edge_survives: 'cost',
  direction: 'strategy',
  regime_persists: 'regime',
  volatility: 'regime',
  attention_decay: 'confirmation',
};

/** Read resolved predictions and turn them into per-component evidence. */
export function componentEvidence(db: DB): ComponentEvidence[] {
  const rows = db
    .prepare(
      `SELECT claim_kind, COUNT(*) n, AVG(brier) mean_brier
       FROM agent_predictions
       WHERE resolved_at IS NOT NULL AND brier IS NOT NULL AND void_reason IS NULL
       GROUP BY claim_kind`,
    )
    .all() as { claim_kind: string; n: number; mean_brier: number }[];

  const acc = new Map<Component, { n: number; weighted: number }>();
  for (const r of rows) {
    const component = CLAIM_TO_COMPONENT[r.claim_kind];
    if (!component) continue;
    const cur = acc.get(component) ?? { n: 0, weighted: 0 };
    cur.n += r.n;
    cur.weighted += r.mean_brier * r.n;
    acc.set(component, cur);
  }
  return [...acc.entries()].map(([component, v]) => ({
    component,
    resolvedN: v.n,
    meanBrier: v.weighted / v.n,
  }));
}

/**
 * The weights the confidence score should use right now. Reads the newest
 * version; if there is none (a DB migrated but never scored) it returns the
 * base weights, which is today's behaviour exactly.
 */
export function currentWeights(db: DB): Record<Component, number> {
  const version = db
    .prepare(`SELECT MAX(version) v FROM confidence_weights`)
    .get() as { v: number | null };
  if (version.v === null) return { ...BASE_WEIGHTS };

  const rows = db
    .prepare(`SELECT component, weight FROM confidence_weights WHERE version = ?`)
    .all(version.v) as { component: Component; weight: number }[];

  const out = { ...BASE_WEIGHTS };
  for (const r of rows) {
    if (r.component in out && Number.isFinite(r.weight)) out[r.component] = r.weight;
  }
  return out;
}

/** Recompute and store a new weight version. Returns what it wrote. */
export function recomputeWeights(db: DB): WeightRow[] {
  const evidence = componentEvidence(db);
  const weights = computeWeights(evidence);
  const current = currentWeights(db);

  // a version per recompute would grow without bound and without meaning;
  // only write when something actually moved
  const moved = weights.some((w) => Math.abs(w.weight - current[w.component]) > 1e-9);
  if (!moved) return weights;

  const next = ((db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as any).v ?? 0) + 1;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO confidence_weights
       (version, component, base_weight, weight, shrunk_skill, resolved_n, inputs_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const w of weights) {
      stmt.run(
        next, w.component, w.baseWeight, w.weight, w.shrunkSkill, w.resolvedN,
        JSON.stringify({ evidence, shrinkN: SHRINK_N, maxAdjust: MAX_ADJUST }),
        now,
      );
    }
  })();
  return weights;
}

/** Rebuild the agent_scores cache from the predictions it summarises. */
export function rebuildAgentScores(db: DB): number {
  const rows = db
    .prepare(
      `SELECT agent, claim_kind, COUNT(*) n, AVG(brier) mean_brier,
              AVG(CASE WHEN (probability >= 0.5) = (outcome = 1) THEN 1.0 ELSE 0.0 END) hit_rate
       FROM agent_predictions
       WHERE resolved_at IS NOT NULL AND brier IS NOT NULL AND void_reason IS NULL
       GROUP BY agent, claim_kind`,
    )
    .all() as { agent: string; claim_kind: string; n: number; mean_brier: number; hit_rate: number }[];

  const stmt = db.prepare(
    `INSERT INTO agent_scores (agent, claim_kind, resolved_n, mean_brier, hit_rate, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent, claim_kind) DO UPDATE SET
       resolved_n = excluded.resolved_n, mean_brier = excluded.mean_brier,
       hit_rate = excluded.hit_rate, computed_at = excluded.computed_at`,
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(r.agent, r.claim_kind, r.n, r.mean_brier, r.hit_rate, Date.now());
  })();
  return rows.length;
}

export interface TrackRecord {
  agent: string;
  claimKind: string;
  resolvedN: number;
  meanBrier: number;
  hitRate: number;
  /** what a coin flip would have scored — the only fair comparison */
  baselineBrier: number;
  beatsBaseline: boolean;
}

/** The public track record, including the parts that look bad. */
export function trackRecord(db: DB, agent?: string): TrackRecord[] {
  const rows = (agent
    ? db.prepare(`SELECT * FROM agent_scores WHERE agent = ? ORDER BY resolved_n DESC`).all(agent)
    : db.prepare(`SELECT * FROM agent_scores ORDER BY resolved_n DESC`).all()) as any[];
  return rows.map((r) => ({
    agent: r.agent,
    claimKind: r.claim_kind,
    resolvedN: r.resolved_n,
    meanBrier: r.mean_brier,
    hitRate: r.hit_rate,
    baselineBrier: COIN_FLIP_BRIER,
    beatsBaseline: r.mean_brier < COIN_FLIP_BRIER,
  }));
}

/**
 * How sure an agent has EARNED the right to sound about a kind of claim. Below
 * 20 resolved predictions, or with a Brier no better than a coin flip, stated
 * confidence is capped at 60 however certain the model sounds.
 */
export function confidenceGate(db: DB, agent: string, claimKind: string, stated: number): number {
  const row = db
    .prepare(`SELECT resolved_n, mean_brier FROM agent_scores WHERE agent = ? AND claim_kind = ?`)
    .get(agent, claimKind) as { resolved_n: number; mean_brier: number } | undefined;
  if (!row || row.resolved_n < 20 || row.mean_brier >= COIN_FLIP_BRIER) return Math.min(stated, 60);
  return clamp(stated, 0, 100);
}
