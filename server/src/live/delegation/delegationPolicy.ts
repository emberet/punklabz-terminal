import {
  CEILING_TIERS, MIN_TRADE_USD,
  type DelegationCaps, type DelegationCeiling, type RiskCheck,
} from '@punklabz/shared';
import type { DB } from '../../db/db.js';
import { fromMicro, toMicro } from '../../money.js';
import { getLiveConfig, promotionEvidence } from '../riskEngine.js';
import { resolveLiveInstrument, type LiveInstrumentSpec } from '../instrumentResolver.js';

// The delegation gate. Consulted by the risk engine IN ADDITION to every global
// limit — a delegated order must satisfy both the network's rules and the
// wallet owner's own.
//
// The ceiling here is deliberately asymmetric with setCapitalStage(): there is
// NO force parameter and no path that raises a tier without evidence. Capital
// stages risk the operator's money; delegation risks someone else's.

export interface DelegationEvidence {
  liveFills: number;
  daysSinceFirstLiveFill: number;
  reconClean30d: boolean;
  haltsLast30d: number;
  capBreachIncidents: number;
  externallyAudited: boolean;
  drawdownPct: number;
  failedOrders: number;
  modeIsLive: boolean;
}

export function delegationEvidence(db: DB): DelegationEvidence {
  const cfg = getLiveConfig(db);
  const base = promotionEvidence(db);
  const monthAgo = Date.now() - 30 * 86_400_000;

  const live = db
    .prepare(
      `SELECT COUNT(*) n, MIN(o.updated_at) first_at
       FROM live_orders o JOIN execution_accounts a ON a.id = o.execution_account_id
       WHERE a.mode = 'live' AND o.state = 'filled'`,
    )
    .get() as { n: number; first_at: number | null };

  const drift = db
    .prepare(`SELECT COUNT(*) n FROM balance_snapshots WHERE ts >= ? AND within_tolerance = 0`)
    .get(monthAgo) as { n: number };
  const halts = db
    .prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'live_halt' AND ts >= ?`)
    .get(monthAgo) as { n: number };
  const breaches = db
    .prepare(`SELECT COUNT(*) n FROM delegation_events WHERE event = 'cap_denied' AND ts >= ?`)
    .get(monthAgo) as { n: number };
  const stored = storedCeilingRow(db);

  return {
    liveFills: live.n,
    daysSinceFirstLiveFill: live.first_at ? (Date.now() - live.first_at) / 86_400_000 : 0,
    reconClean30d: drift.n === 0,
    haltsLast30d: halts.n,
    capBreachIncidents: breaches.n,
    externallyAudited: stored.externally_audited === 1,
    drawdownPct: base.drawdownPct,
    failedOrders: base.failedOrders,
    modeIsLive: cfg.mode === 'live',
  };
}

/** PURE. Which tier the measured evidence has actually earned. */
export function earnedTier(ev: DelegationEvidence): number {
  if (
    !ev.modeIsLive ||
    ev.liveFills < 25 ||
    ev.daysSinceFirstLiveFill < 14 ||
    !ev.reconClean30d ||
    ev.failedOrders > 0 ||
    ev.drawdownPct > 5
  ) {
    return 0;
  }
  if (
    ev.liveFills >= 250 &&
    ev.daysSinceFirstLiveFill >= 60 &&
    ev.haltsLast30d === 0 &&
    ev.capBreachIncidents === 0
  ) {
    if (ev.liveFills >= 2000 && ev.daysSinceFirstLiveFill >= 180 && ev.externallyAudited) return 3;
    return 2;
  }
  return 1;
}

/** PURE. Why the next tier is not available yet, in words. */
export function tierBlockers(ev: DelegationEvidence): string[] {
  const out: string[] = [];
  if (!ev.modeIsLive) out.push('execution mode is not live');
  if (ev.liveFills < 25) out.push(`${ev.liveFills} / 25 clean live fills`);
  if (ev.daysSinceFirstLiveFill < 14) out.push(`${ev.daysSinceFirstLiveFill.toFixed(1)} / 14 days live`);
  if (!ev.reconClean30d) out.push('reconciliation drifted in the last 30 days');
  if (ev.failedOrders > 0) out.push(`${ev.failedOrders} failed/unresolved order(s)`);
  if (ev.drawdownPct > 5) out.push(`drawdown ${ev.drawdownPct.toFixed(1)}% above 5%`);
  return out;
}

function storedCeilingRow(db: DB): any {
  return db.prepare(`SELECT * FROM delegation_ceiling ORDER BY id DESC LIMIT 1`).get();
}

/**
 * The ceiling in force = min(earned, stored). An admin can hold it LOWER than
 * evidence supports; there is no argument that raises it above.
 */
export function delegationCeiling(db: DB): DelegationCeiling {
  const ev = delegationEvidence(db);
  const stored = storedCeilingRow(db);
  const tier = Math.min(earnedTier(ev), stored?.tier ?? 0);
  const spec = CEILING_TIERS[tier] ?? CEILING_TIERS[0];
  return {
    tier,
    perTradeUsd: spec.perTradeUsd,
    dailyUsd: spec.dailyUsd,
    cumulativeUsd: spec.cumulativeUsd,
    maxGrantsPerUser: spec.maxGrantsPerUser,
    maxTotalDelegatedUsd: spec.maxTotalDelegatedUsd,
    externallyAudited: ev.externallyAudited,
    blockers: tierBlockers(ev),
    evidence: { ...ev },
  };
}

/** PURE. Clamp what the user asked for to what the ceiling allows. */
export function effectiveCaps(
  requested: DelegationCaps,
  ceiling: DelegationCeiling,
): { caps: DelegationCaps; clampedFields: string[] } {
  const clampedFields: string[] = [];
  const clamp = (field: keyof DelegationCaps, max: number) => {
    const asked = requested[field];
    if (asked > max) {
      clampedFields.push(field);
      return max;
    }
    return Math.max(0, asked);
  };
  return {
    caps: {
      perTradeUsd: clamp('perTradeUsd', ceiling.perTradeUsd),
      dailyUsd: clamp('dailyUsd', ceiling.dailyUsd),
      cumulativeUsd: clamp('cumulativeUsd', ceiling.cumulativeUsd),
      maxOpenNotionalUsd: clamp('maxOpenNotionalUsd', ceiling.cumulativeUsd),
      maxSlippageBps: clamp('maxSlippageBps', 35),
    },
    clampedFields,
  };
}

export interface AllowedToken {
  token_address: string;
  role: string;
}

/**
 * PURE. Both legs of the pair must be on the grant's whitelist, at the right
 * role, on the grant's chain. Checking only the base is how a grant that
 * authorised USDG gets spent out of a different quote token.
 */
export function checkTokens(
  spec: LiveInstrumentSpec,
  allowed: AllowedToken[],
  grantChainId: number,
): RiskCheck[] {
  const checks: RiskCheck[] = [];
  if (spec.chainId !== grantChainId) {
    checks.push({
      name: 'delegation_chain', pass: false,
      detail: `instrument is chain ${spec.chainId}, grant is ${grantChainId}`,
    });
  } else {
    checks.push({ name: 'delegation_chain', pass: true, detail: `chain ${grantChainId}` });
  }
  const has = (addr: string, role: string) =>
    allowed.some((a) => a.token_address.toLowerCase() === addr.toLowerCase() && a.role === role);
  const baseOk = has(spec.base.address, 'base');
  const quoteOk = has(spec.quote.address, 'quote');
  if (!baseOk || !quoteOk) {
    const missing = [!baseOk && spec.base.symbol, !quoteOk && spec.quote.symbol].filter(Boolean);
    checks.push({
      name: 'delegation_token', pass: false,
      detail: `not on this grant whitelist: ${missing.join(', ')}`,
    });
  } else {
    checks.push({
      name: 'delegation_token', pass: true,
      detail: `${spec.base.symbol}/${spec.quote.symbol} whitelisted`,
    });
  }
  return checks;
}

export interface GrantSpend {
  settledUsd: number;
  reservedUsd: number;
  todayUsd: number;
  usedUsd: number;
}

/** Spend read from the usage ledger — never from anything a client supplied. */
export function grantSpend(db: DB, grantId: number): GrantSpend {
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'settled'  THEN amount_micro ELSE 0 END), 0) settled,
         COALESCE(SUM(CASE WHEN kind IN ('reserved','released') THEN amount_micro ELSE 0 END), 0) reserved
       FROM delegation_usage WHERE grant_id = ?`,
    )
    .get(grantId) as { settled: number; reserved: number };
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(amount_micro), 0) s FROM delegation_usage
       WHERE grant_id = ? AND ts >= ? AND kind IN ('settled','reserved','released')`,
    )
    .get(grantId, dayStart) as { s: number };
  const settledUsd = fromMicro(totals.settled);
  const reservedUsd = Math.max(0, fromMicro(totals.reserved));
  return {
    settledUsd,
    reservedUsd,
    todayUsd: Math.max(0, fromMicro(today.s)),
    usedUsd: settledUsd + reservedUsd,
  };
}

/** How much this grant can still spend right now, across every cap. */
export function grantHeadroomUsd(db: DB, grantId: number): number {
  const grant = db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId) as any;
  if (!grant) return 0;
  const spend = grantSpend(db, grantId);
  return Math.max(
    0,
    Math.min(
      fromMicro(grant.per_trade_cap_micro),
      fromMicro(grant.cumulative_cap_micro) - spend.usedUsd,
      fromMicro(grant.daily_cap_micro) - spend.todayUsd,
    ),
  );
}

/**
 * The delegation checks, shaped as RiskCheck[] so the risk engine's existing
 * rejection, persistence and audit machinery need no changes.
 */
export function evaluateDelegation(
  db: DB,
  grantId: number,
  intent: { instrumentId: string; side: 'buy' | 'sell'; notionalUsd: number },
  approvedSizeUsd: number,
  hasOpenLot = false,
): RiskCheck[] {
  const checks: RiskCheck[] = [];
  const fail = (name: string, detail: string) => checks.push({ name, pass: false, detail });
  const pass = (name: string, detail: string) => checks.push({ name, pass: true, detail });

  const grant = db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId) as any;
  if (!grant) {
    fail('delegation_grant', `grant ${grantId} not found`);
    return checks;
  }

  // Exits are never blocked. You must always be able to close a position, even
  // after the owner revokes — otherwise revocation traps them in a trade.
  const isExit = intent.side === 'sell' && hasOpenLot;
  const dead = grant.status !== 'active';
  if (dead && isExit) {
    pass('delegation_exit_only', `grant ${grant.status} — exits only`);
    return checks;
  }
  if (dead) {
    fail('delegation_grant', `grant is ${grant.status}, not active`);
    return checks;
  }
  pass('delegation_grant', `grant ${grantId} active`);

  if (grant.expires_at <= Date.now()) fail('delegation_expiry', 'grant has expired');
  else pass('delegation_expiry', `expires in ${((grant.expires_at - Date.now()) / 86_400_000).toFixed(1)}d`);

  if (!grant.session_signer_id) fail('delegation_signer', 'no session signer bound at the provider');
  else pass('delegation_signer', 'session signer bound');

  // token whitelist AND the resolver's own spec — the ticker-collision defence
  const resolution = resolveLiveInstrument(intent.instrumentId.split('/').pop() ?? '');
  if (!resolution.mapped || !resolution.spec) {
    fail('delegation_token', resolution.reason);
  } else {
    const allowed = db
      .prepare(`SELECT token_address, role FROM delegation_tokens WHERE grant_id = ?`)
      .all(grantId) as AllowedToken[];
    for (const c of checkTokens(resolution.spec, allowed, grant.chain_id)) checks.push(c);
  }

  // Spend caps govern money leaving the wallet. Closing a position returns
  // funds to it, so charging an exit against the cap would let someone open a
  // trade with their last dollar of cap and then be unable to get out of it.
  if (isExit) {
    pass('delegation_exit', 'closing an open position — spend caps do not apply');
  } else {
    const spend = grantSpend(db, grantId);
    const perTrade = fromMicro(grant.per_trade_cap_micro);
    const daily = fromMicro(grant.daily_cap_micro);
    const cumulative = fromMicro(grant.cumulative_cap_micro);

    // THE CHECK THAT ACTUALLY BITES. The caller clamps size to headroom, which
    // makes the three cap checks below pass trivially — they stay as defence
    // against a caller that ignores the clamp, but a grant with nothing left
    // has to be refused by name, not by a downstream "size too small".
    const headroom = grantHeadroomUsd(db, grantId);
    if (headroom < MIN_TRADE_USD)
      fail('delegation_headroom',
        `$${headroom.toFixed(2)} of headroom left (today $${spend.todayUsd.toFixed(2)}/$${daily.toFixed(2)}, lifetime $${spend.usedUsd.toFixed(2)}/$${cumulative.toFixed(2)})`);
    else pass('delegation_headroom', `$${headroom.toFixed(2)} available`);

    if (approvedSizeUsd > perTrade)
      fail('delegation_per_trade', `size $${approvedSizeUsd.toFixed(2)} over per-trade cap $${perTrade.toFixed(2)}`);
    else pass('delegation_per_trade', `$${approvedSizeUsd.toFixed(2)} / $${perTrade.toFixed(2)} per trade`);

    if (spend.todayUsd + approvedSizeUsd > daily)
      fail('delegation_daily', `would spend $${(spend.todayUsd + approvedSizeUsd).toFixed(2)} today, cap $${daily.toFixed(2)}`);
    else pass('delegation_daily', `$${spend.todayUsd.toFixed(2)} / $${daily.toFixed(2)} today`);

    if (spend.usedUsd + approvedSizeUsd > cumulative)
      fail('delegation_cumulative', `would reach $${(spend.usedUsd + approvedSizeUsd).toFixed(2)} of $${cumulative.toFixed(2)} lifetime`);
    else pass('delegation_cumulative', `$${spend.usedUsd.toFixed(2)} / $${cumulative.toFixed(2)} lifetime`);

    // the ceiling can drop; a live grant shrinks with it rather than being grandfathered
    const ceiling = delegationCeiling(db);
    if (perTrade > ceiling.perTradeUsd)
      fail('delegation_ceiling', `grant cap $${perTrade.toFixed(2)} exceeds current tier ${ceiling.tier} ceiling $${ceiling.perTradeUsd.toFixed(2)}`);
    else pass('delegation_ceiling', `within tier ${ceiling.tier} ceiling`);
  }

  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    db.prepare(
      `INSERT INTO delegation_events (grant_id, ts, event, actor, detail_json) VALUES (?, ?, 'cap_denied', 'risk-engine', ?)`,
    ).run(grantId, Date.now(), JSON.stringify({ failed: failed.map((f) => f.name), sizeUsd: approvedSizeUsd }));
  }
  return checks;
}

/** Reserve cap before submission so concurrent intents can't double-spend it. */
export function reserveSpend(
  db: DB,
  grantId: number,
  intentId: string,
  instrumentId: string,
  amountUsd: number,
): boolean {
  try {
    db.prepare(
      `INSERT INTO delegation_usage (grant_id, intent_id, kind, amount_micro, instrument_id, ts)
       VALUES (?, ?, 'reserved', ?, ?, ?)`,
    ).run(grantId, intentId, toMicro(amountUsd), instrumentId, Date.now());
    return true;
  } catch {
    return false; // already reserved — the unique index did its job
  }
}

export function settleSpend(db: DB, grantId: number, intentId: string, instrumentId: string, actualUsd: number, orderId?: number): void {
  const tx = db.transaction(() => {
    // release the reservation, then book what actually happened
    const reserved = db
      .prepare(`SELECT amount_micro FROM delegation_usage WHERE intent_id = ? AND kind = 'reserved'`)
      .get(intentId) as { amount_micro: number } | undefined;
    if (reserved) {
      db.prepare(
        `INSERT OR IGNORE INTO delegation_usage (grant_id, intent_id, kind, amount_micro, instrument_id, ts, note)
         VALUES (?, ?, 'released', ?, ?, ?, 'reservation settled')`,
      ).run(grantId, intentId, -reserved.amount_micro, instrumentId, Date.now());
    }
    db.prepare(
      `INSERT OR IGNORE INTO delegation_usage (grant_id, intent_id, order_id, kind, amount_micro, instrument_id, ts)
       VALUES (?, ?, ?, 'settled', ?, ?, ?)`,
    ).run(grantId, intentId, orderId ?? null, toMicro(actualUsd), instrumentId, Date.now());
  });
  tx();
}

/** Order never made it to a venue — give the cap back. */
export function releaseSpend(db: DB, grantId: number, intentId: string, instrumentId: string, reason: string): void {
  const reserved = db
    .prepare(`SELECT amount_micro FROM delegation_usage WHERE intent_id = ? AND kind = 'reserved'`)
    .get(intentId) as { amount_micro: number } | undefined;
  if (!reserved) return;
  db.prepare(
    `INSERT OR IGNORE INTO delegation_usage (grant_id, intent_id, kind, amount_micro, instrument_id, ts, note)
     VALUES (?, ?, 'released', ?, ?, ?, ?)`,
  ).run(grantId, intentId, -reserved.amount_micro, instrumentId, Date.now(), reason);
}
