import type { DB } from '../db/db.js';
import type { CandleStore } from '../feeds/candles.js';
import { atr } from '../engine/indicators.js';
import { rebuildAgentScores, recomputeWeights } from './scoring.js';

// FALSIFIABLE CLAIMS.
//
// Opening a prediction is a plain insert with no model in the loop: the
// resolution rule and the baseline are frozen at open, so there is no version
// of the future in which a claim gets marked correct by rewriting what it meant.
//
// A prediction that cannot be settled honestly is VOIDED, never guessed. A
// voided row is excluded from every score — a missing candle must not read as
// a correct forecast.

export type ClaimKind =
  | 'edge_survives'
  | 'direction'
  | 'regime_persists'
  | 'volatility'
  | 'attention_decay';

export interface OpenPrediction {
  agent: string;
  botId?: number | null;
  observationId?: number | null;
  claimKind: ClaimKind;
  subject: string;
  probability: number;
  resolutionRule: string;
  resolver: string;
  baseline: Record<string, unknown>;
  horizonMs: number;
}

export function openPrediction(db: DB, p: OpenPrediction): number {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO agent_predictions
         (agent, bot_id, observation_id, claim_kind, subject, probability,
          resolution_rule, resolver, baseline_json, horizon_ms, opened_at, resolves_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.agent, p.botId ?? null, p.observationId ?? null, p.claimKind, p.subject,
      Math.max(0, Math.min(1, p.probability)),
      p.resolutionRule, p.resolver, JSON.stringify(p.baseline),
      p.horizonMs, now, now + p.horizonMs,
    );
  return Number(info.lastInsertRowid);
}

/** the price move a directional claim is measured against, frozen at open */
export function openDirectionClaim(
  db: DB,
  agent: string,
  symbol: string,
  price: number,
  side: 'buy' | 'sell',
  probability: number,
  horizonMs = 4 * 3_600_000,
  botId?: number | null,
): number | null {
  if (!(price > 0)) return null;
  return openPrediction(db, {
    agent, botId, claimKind: 'direction', subject: symbol, probability,
    resolver: 'price_move',
    resolutionRule:
      `${symbol} closes ${side === 'buy' ? 'above' : 'below'} ${price.toFixed(6)} ` +
      `${(horizonMs / 3_600_000).toFixed(0)}h from open`,
    baseline: { price, side, symbol },
    horizonMs,
  });
}

/** did the modelled net edge actually survive the round trip we paid for? */
export function openEdgeClaim(
  db: DB,
  agent: string,
  symbol: string,
  price: number,
  netEdgeBps: number,
  probability: number,
  botId?: number | null,
  horizonMs = 6 * 3_600_000,
): number | null {
  // without a reference price at open there is nothing to measure the move
  // against later, so the claim is not opened at all rather than opened unresolvable
  if (!Number.isFinite(netEdgeBps) || !(price > 0)) return null;
  return openPrediction(db, {
    agent, botId, claimKind: 'edge_survives', subject: symbol, probability,
    resolver: 'edge_realised',
    resolutionRule:
      `the realised move on ${symbol} from ${price.toFixed(6)} exceeds the ` +
      `${netEdgeBps.toFixed(1)}bps of net edge this order was priced on, ` +
      `within ${(horizonMs / 3_600_000).toFixed(0)}h`,
    baseline: { netEdgeBps, symbol, price },
    horizonMs,
  });
}

export interface ResolveReport {
  resolved: number;
  voided: number;
  weightsMoved: boolean;
}

/**
 * Settle everything due. Runs on a cron; deterministic, no model involved.
 */
export function resolvePredictions(db: DB, candles: CandleStore, markOf: (s: string) => number | null): ResolveReport {
  const due = db
    .prepare(`SELECT * FROM agent_predictions WHERE resolved_at IS NULL AND resolves_at <= ?`)
    .all(Date.now()) as any[];

  let resolved = 0;
  let voided = 0;

  const settle = db.prepare(
    `UPDATE agent_predictions SET resolved_at = ?, outcome = ?, outcome_json = ?, brier = ? WHERE id = ?`,
  );
  const voidIt = db.prepare(
    `UPDATE agent_predictions SET resolved_at = ?, void_reason = ?, outcome_json = ? WHERE id = ?`,
  );

  for (const p of due) {
    const baseline = JSON.parse(p.baseline_json);
    const symbol: string = baseline.symbol ?? p.subject;
    const now = markOf(symbol);

    if (now === null || !(now > 0)) {
      // No mark means we cannot say what happened. Guessing here would quietly
      // manufacture a track record.
      voided++;
      voidIt.run(Date.now(), `no mark available for ${symbol} at resolution`, JSON.stringify({ symbol }), p.id);
      continue;
    }

    let happened: boolean | null = null;
    let outcomeDetail: Record<string, unknown> = { symbol, price: now };

    if (p.resolver === 'price_move') {
      const opened = Number(baseline.price);
      happened = baseline.side === 'buy' ? now > opened : now < opened;
      outcomeDetail = { symbol, openedAt: opened, resolvedAt: now, movePct: ((now - opened) / opened) * 100 };
    } else if (p.resolver === 'edge_realised') {
      const openMark = Number(baseline.price ?? baseline.openPrice);
      const ref = Number.isFinite(openMark) && openMark > 0 ? openMark : null;
      if (ref === null) {
        // an edge claim opened without a reference price cannot be measured
        voided++;
        voidIt.run(Date.now(), 'no reference price recorded at open', JSON.stringify(outcomeDetail), p.id);
        continue;
      }
      const movedBps = Math.abs((now - ref) / ref) * 10_000;
      happened = movedBps >= Number(baseline.netEdgeBps);
      outcomeDetail = { symbol, movedBps, requiredBps: Number(baseline.netEdgeBps) };
    } else if (p.resolver === 'volatility') {
      const hist = candles.history(symbol, '15m', 60);
      const a = atr(hist, 14);
      if (a === null) {
        voided++;
        voidIt.run(Date.now(), 'not enough candles to measure volatility', JSON.stringify(outcomeDetail), p.id);
        continue;
      }
      const atrPct = (a / now) * 100;
      happened = atrPct >= Number(baseline.atrPct);
      outcomeDetail = { symbol, atrPct, baselineAtrPct: Number(baseline.atrPct) };
    } else {
      voided++;
      voidIt.run(Date.now(), `no resolver named ${p.resolver}`, JSON.stringify(outcomeDetail), p.id);
      continue;
    }

    const outcome = happened ? 1 : 0;
    const brier = (p.probability - outcome) ** 2;
    settle.run(Date.now(), outcome, JSON.stringify(outcomeDetail), brier, p.id);
    resolved++;
  }

  if (resolved > 0) {
    rebuildAgentScores(db);
    const before = db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as any;
    recomputeWeights(db);
    const after = db.prepare(`SELECT MAX(version) v FROM confidence_weights`).get() as any;
    return { resolved, voided, weightsMoved: after.v !== before.v };
  }
  return { resolved, voided, weightsMoved: false };
}
