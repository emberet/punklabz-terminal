import type { BotSummary, LeaderboardRow } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { computeEquity } from '../engine/accounting.js';
import { fromMicro, toMicro } from '../money.js';

export function botSummaries(db: DB, markOf: (s: string) => number | undefined): BotSummary[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.name, b.kind, b.strategy_type, b.status, b.cloned_from_bot_id, b.created_at,
              u.display_name AS owner_name,
              a.cash_micro, a.initial_balance_micro
       FROM bots b
       LEFT JOIN users u ON u.id = b.owner_user_id
       JOIN bot_accounts a ON a.bot_id = b.id
       ORDER BY b.id ASC`,
    )
    .all() as any[];

  return rows.map((r) => {
    const eq = computeEquity(db, r.id, markOf);
    const dayAgo = Date.now() - 86_400_000;
    const past = db
      .prepare(
        `SELECT equity_micro FROM bot_metrics WHERE bot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(r.id, dayAgo) as { equity_micro: number } | undefined;
    const base = past?.equity_micro ?? r.initial_balance_micro;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      strategyType: r.strategy_type,
      status: r.status,
      ownerName: r.owner_name ?? null,
      equityUsd: fromMicro(eq.equityMicro),
      cashUsd: fromMicro(r.cash_micro),
      initialBalanceUsd: fromMicro(r.initial_balance_micro),
      realizedPnlUsd: fromMicro(eq.realizedPnlMicro),
      unrealizedPnlUsd: fromMicro(eq.unrealizedPnlMicro),
      pnlPct24h: base > 0 ? ((eq.equityMicro - base) / base) * 100 : 0,
      tradeCount: eq.tradeCount,
      winCount: eq.winCount,
      clonedFromBotId: r.cloned_from_bot_id,
      createdAt: r.created_at,
    } satisfies BotSummary;
  });
}

export function leaderboard(
  db: DB,
  markOf: (s: string) => number | undefined,
  windowMs: number | null,
): LeaderboardRow[] {
  const bots = botSummaries(db, markOf);
  const since = windowMs === null ? null : Date.now() - windowMs;

  const rows = bots.map((b) => {
    let pnlUsd: number;
    let pnlPct: number;
    let tradeCount: number;
    let winRate: number;

    if (since === null) {
      pnlUsd = b.equityUsd - b.initialBalanceUsd;
      pnlPct = b.initialBalanceUsd > 0 ? (pnlUsd / b.initialBalanceUsd) * 100 : 0;
      tradeCount = b.tradeCount;
      winRate = b.tradeCount > 0 ? (b.winCount / Math.max(1, sellCount(db, b.id, null))) * 100 : 0;
    } else {
      const past = db
        .prepare(`SELECT equity_micro FROM bot_metrics WHERE bot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`)
        .get(b.id, since) as { equity_micro: number } | undefined;
      const baseUsd = past ? fromMicro(past.equity_micro) : b.initialBalanceUsd;
      pnlUsd = b.equityUsd - baseUsd;
      pnlPct = baseUsd > 0 ? (pnlUsd / baseUsd) * 100 : 0;
      const agg = db
        .prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN side = 'sell' AND realized_pnl_micro > 0 THEN 1 ELSE 0 END) AS wins,
                  SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells
           FROM trades WHERE bot_id = ? AND ts >= ?`,
        )
        .get(b.id, since) as { n: number; wins: number | null; sells: number | null };
      tradeCount = agg.n;
      winRate = (agg.sells ?? 0) > 0 ? ((agg.wins ?? 0) / (agg.sells ?? 1)) * 100 : 0;
    }

    return {
      rank: 0,
      botId: b.id,
      name: b.name,
      kind: b.kind,
      ownerName: b.ownerName,
      pnlPct,
      pnlUsd,
      winRate,
      tradeCount,
      maxDrawdownPct: maxDrawdown(db, b.id, since),
      ageDays: (Date.now() - b.createdAt) / 86_400_000,
    } satisfies LeaderboardRow;
  });

  rows.sort((a, b) => b.pnlPct - a.pnlPct);
  rows.forEach((r, i) => (r.rank = i + 1));

  // 24h rank movement: rank bots by yesterday's pnl (equity@-24h vs @-48h)
  if (windowMs === 86_400_000) {
    const now = Date.now();
    const prev = bots.map((b) => {
      const at = (ts: number) =>
        (db
          .prepare(`SELECT equity_micro FROM bot_metrics WHERE bot_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`)
          .get(b.id, ts) as { equity_micro: number } | undefined)?.equity_micro ?? null;
      const e24 = at(now - 86_400_000);
      const e48 = at(now - 2 * 86_400_000);
      const base = e48 ?? toMicro(b.initialBalanceUsd);
      return {
        botId: b.id,
        hadHistory: e24 !== null,
        prevPnlPct: e24 !== null && base > 0 ? ((e24 - base) / base) * 100 : null,
      };
    });
    const ranked = prev
      .filter((p) => p.prevPnlPct !== null)
      .sort((a, b) => (b.prevPnlPct! - a.prevPnlPct!));
    const prevRank = new Map(ranked.map((p, i) => [p.botId, i + 1]));
    for (const r of rows) {
      const pr = prevRank.get(r.botId);
      (r as LeaderboardRow & { rankDelta24h?: number | null }).rankDelta24h =
        pr === undefined ? null : pr - r.rank;
    }
  }
  return rows;
}

function sellCount(db: DB, botId: number, since: number | null): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM trades WHERE bot_id = ? AND side = 'sell' AND ts >= ?`)
    .get(botId, since ?? 0) as { n: number };
  return row.n;
}

function maxDrawdown(db: DB, botId: number, since: number | null): number {
  const rows = db
    .prepare(`SELECT equity_micro FROM bot_metrics WHERE bot_id = ? AND ts >= ? ORDER BY ts ASC`)
    .all(botId, since ?? 0) as { equity_micro: number }[];
  let peak = 0;
  let maxDd = 0;
  for (const r of rows) {
    peak = Math.max(peak, r.equity_micro);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - r.equity_micro) / peak) * 100);
  }
  return maxDd;
}
