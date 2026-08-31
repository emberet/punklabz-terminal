import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { toMicro } from '../money.js';

// SPEND CONTROL FOR EVERY MODEL CALL.
//
// Two independent problems, both of which have already bitten this codebase in
// the same place:
//
//  1. RATE LIMITS THAT LIVE IN A VARIABLE DIE ON RESTART. forum.ts kept its
//     last-post timestamp in a module-level `let`. A crash loop reset it every
//     time the process came back, so a process failing every 30 seconds could
//     post to the room — and bill the API — on every single boot, forever,
//     while every log line looked normal. The limit now lives in the database,
//     which is the only place that survives the thing it is protecting against.
//
//  2. A MONTHLY CAP HAS TO BE CHECKED BEFORE THE CALL, NOT AFTER. And it has to
//     count MEASURED tokens from the API's own usage field, never an estimate,
//     or the number that stops you is fiction.

/** Haiku pricing, USD per million tokens. Update alongside the model constant. */
const PRICE_IN_PER_MTOK = 1.0;
const PRICE_OUT_PER_MTOK = 5.0;

export function costUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * PRICE_IN_PER_MTOK + (tokensOut / 1_000_000) * PRICE_OUT_PER_MTOK;
}

const month = () => new Date().toISOString().slice(0, 7);

export function monthlySpendUsd(db: DB): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_micro), 0) c FROM llm_budget WHERE month = ?`)
    .get(month()) as { c: number };
  return row.c / 1_000_000;
}

export interface BudgetVerdict {
  allowed: boolean;
  spentUsd: number;
  capUsd: number;
  reason: string;
}

/** Called BEFORE every model request. Fails closed on an unreadable budget. */
export function spendGuard(db: DB, caller: string): BudgetVerdict {
  const capUsd = config.llmBudgetUsd;
  let spentUsd: number;
  try {
    spentUsd = monthlySpendUsd(db);
  } catch {
    return { allowed: false, spentUsd: 0, capUsd, reason: 'budget ledger unreadable — refusing to spend' };
  }
  if (spentUsd >= capUsd) {
    return {
      allowed: false, spentUsd, capUsd,
      reason: `monthly LLM budget reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} (${caller})`,
    };
  }
  return { allowed: true, spentUsd, capUsd, reason: `$${(capUsd - spentUsd).toFixed(2)} left this month` };
}

/** Called AFTER a request, with the usage the API actually reported. */
export function recordSpend(db: DB, caller: string, tokensIn: number, tokensOut: number): void {
  const cost = toMicro(costUsd(tokensIn, tokensOut));
  db.prepare(
    `INSERT INTO llm_budget (month, caller, calls, tokens_in, tokens_out, cost_micro)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (month, caller) DO UPDATE SET
       calls = calls + 1,
       tokens_in = tokens_in + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       cost_micro = cost_micro + excluded.cost_micro`,
  ).run(month(), caller, tokensIn, tokensOut, cost);
}

export interface RateLimitSpec {
  /** minimum gap between two actions under this key */
  cooldownMs: number;
  /** optional cap on actions inside a rolling window */
  maxInWindow?: number;
  windowMs?: number;
}

export interface RateVerdict {
  allowed: boolean;
  reason: string;
  retryInMs: number;
}

/**
 * Persistent rate limit. Reserving and recording are the same operation and
 * happen in one transaction, so two concurrent callers cannot both pass.
 */
export function takeRateLimit(db: DB, key: string, spec: RateLimitSpec): RateVerdict {
  const now = Date.now();
  const windowMs = spec.windowMs ?? 86_400_000;

  return db.transaction((): RateVerdict => {
    const row = db
      .prepare(`SELECT * FROM agent_rate_limits WHERE key = ?`)
      .get(key) as { last_at: number; count_window_start: number; count_in_window: number } | undefined;

    if (row) {
      const since = now - row.last_at;
      if (since < spec.cooldownMs) {
        return {
          allowed: false,
          reason: `cooling down (${Math.ceil((spec.cooldownMs - since) / 1000)}s left)`,
          retryInMs: spec.cooldownMs - since,
        };
      }
      const windowExpired = now - row.count_window_start >= windowMs;
      const countInWindow = windowExpired ? 0 : row.count_in_window;
      if (spec.maxInWindow !== undefined && countInWindow >= spec.maxInWindow) {
        const retry = row.count_window_start + windowMs - now;
        return {
          allowed: false,
          reason: `${countInWindow}/${spec.maxInWindow} used in this window`,
          retryInMs: Math.max(0, retry),
        };
      }
      db.prepare(
        `UPDATE agent_rate_limits SET last_at = ?, count_window_start = ?, count_in_window = ? WHERE key = ?`,
      ).run(now, windowExpired ? now : row.count_window_start, countInWindow + 1, key);
    } else {
      db.prepare(
        `INSERT INTO agent_rate_limits (key, last_at, count_window_start, count_in_window) VALUES (?, ?, ?, 1)`,
      ).run(key, now, now);
    }
    return { allowed: true, reason: 'ok', retryInMs: 0 };
  })();
}

export interface BudgetView {
  month: string;
  capUsd: number;
  spentUsd: number;
  byCaller: { caller: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number }[];
}

export function budgetView(db: DB): BudgetView {
  const rows = db
    .prepare(`SELECT * FROM llm_budget WHERE month = ? ORDER BY cost_micro DESC`)
    .all(month()) as any[];
  return {
    month: month(),
    capUsd: config.llmBudgetUsd,
    spentUsd: monthlySpendUsd(db),
    byCaller: rows.map((r) => ({
      caller: r.caller, calls: r.calls, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      costUsd: r.cost_micro / 1_000_000,
    })),
  };
}
