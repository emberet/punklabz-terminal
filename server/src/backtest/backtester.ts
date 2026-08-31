import {
  FEES, INTERVAL_MS, PAPER,
  type Candle, type ConditionNode, type Interval, type StrategyConfig,
} from '@punklabz/shared';
import { toMicro, fromMicro } from '../money.js';
import type { CandleStore } from '../feeds/candles.js';
import { DslStrategy } from '../engine/strategies/dslStrategy.js';
import type { Intent, StrategyContext } from '../engine/strategies/strategy.js';
import type { OpenPosition } from '../engine/accounting.js';

// Pure in-memory backtest: drives the REAL DslStrategy with a virtualized
// StrategyContext and a broker that mirrors PaperExecutor + applyFill
// semantics exactly (same slippage, fees, and micro-integer accounting).
// The broker never sees a DB handle — writes are structurally impossible.

export interface BacktestTrade {
  ts: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  feeUsd: number;
  realizedPnlUsd: number;
  reason: string;
}

export interface BacktestResult {
  effectiveWindow: { fromTs: number; toTs: number; interval: Interval; bars: number; coveragePct: number };
  warnings: string[];
  initialBalanceUsd: number;
  finalEquityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  tradeCount: number;
  winRate: number;
  maxDrawdownPct: number;
  estimatedTradeTaxUsd: number;
  trades: BacktestTrade[];
  equityCurve: { ts: number; equityUsd: number }[];
  buyHold: { pnlPct: number; curve: { ts: number; equityUsd: number }[] };
}

export class BacktestError extends Error {}

/** live gauge for presence stats + route concurrency cap */
export const backtestLoad = { inFlight: 0 };

/** max lookback any condition needs, so indicators are warm at window start */
function warmupBars(cfg: StrategyConfig): number {
  let max = 5;
  const walk = (node: ConditionNode) => {
    if ('all' in node) node.all.forEach(walk);
    else if ('any' in node) node.any.forEach(walk);
    else if ('not' in node) walk(node.not);
    else if (node.kind === 'indicator') {
      if (node.period !== undefined) max = Math.max(max, node.period + 1);
      if (node.lookbackBars !== undefined) max = Math.max(max, node.lookbackBars + 1);
      if (node.valueRef?.period !== undefined) max = Math.max(max, node.valueRef.period + 1);
      if (node.valueRef?.lookbackBars !== undefined) max = Math.max(max, node.valueRef.lookbackBars + 1);
    }
  };
  walk(cfg.entry);
  walk(cfg.exit);
  return Math.min(max, 210);
}

class BacktestContext implements StrategyContext {
  botId = -1;
  now = 0;
  cashUsd: number;
  initialBalanceUsd: number;
  positions: OpenPosition[] = [];

  cashMicro: number;
  private windows = new Map<string, Candle[]>();
  private cursors = new Map<string, number>();
  private lastTradeTs = new Map<string, number>();
  private tradeTs: number[] = [];
  private posId = 0;

  constructor(
    private interval: Interval,
    initialBalanceUsd: number,
  ) {
    this.initialBalanceUsd = initialBalanceUsd;
    this.cashUsd = initialBalanceUsd;
    this.cashMicro = toMicro(initialBalanceUsd);
  }

  loadSymbol(symbol: string, candles: Candle[]) {
    this.windows.set(symbol, candles);
    this.cursors.set(symbol, -1);
  }

  /** advance the per-symbol cursor to this bar and set the virtual clock */
  advance(candle: Candle) {
    const w = this.windows.get(candle.symbol);
    if (!w) return;
    const cur = this.cursors.get(candle.symbol) ?? -1;
    // candles arrive in ts order per symbol; cursor moves forward one bar
    this.cursors.set(candle.symbol, cur + 1);
    // live analog: onCandle fires at bar close, Date.now() ≈ close time
    this.now = candle.ts + INTERVAL_MS[this.interval];
    this.cashUsd = fromMicro(this.cashMicro);
  }

  history(symbol: string, iv?: Interval): Candle[] {
    if (iv !== undefined && iv !== this.interval) return [];
    const w = this.windows.get(symbol) ?? [];
    const end = (this.cursors.get(symbol) ?? -1) + 1; // inclusive of current bar (live parity)
    return w.slice(Math.max(0, end - 300), end);      // live history() caps at 300
  }

  mark(symbol: string): number | undefined {
    const w = this.windows.get(symbol) ?? [];
    const i = this.cursors.get(symbol) ?? -1;
    return i >= 0 ? w[i].c : undefined;
  }

  minutesSinceLastTrade(symbol: string): number {
    const ts = this.lastTradeTs.get(symbol);
    return ts === undefined ? Infinity : (this.now - ts) / 60_000;
  }

  tradesToday(): number {
    const dayStart = Math.floor(this.now / 86_400_000) * 86_400_000;
    return this.tradeTs.filter((t) => t >= dayStart).length;
  }

  recordTrade(symbol: string) {
    this.lastTradeTs.set(symbol, this.now);
    this.tradeTs.push(this.now);
  }

  nextPosId(): number {
    return ++this.posId;
  }
}

export async function runBacktest(
  candles: CandleStore,
  cfg: StrategyConfig,
  opts: { fromTs: number; toTs: number },
): Promise<BacktestResult> {
  const interval = cfg.market.interval;
  const warmup = warmupBars(cfg);
  const fetchFrom = opts.fromTs - warmup * INTERVAL_MS[interval];

  // fetch + merge symbol tapes (warmup included; equity curve starts at fromTs).
  // 5m/15m are aggregated from stored 1m bars — full 7d retention — rather than
  // relying on live-aggregated rows that only exist since the last server start.
  const perSymbol = new Map<string, Candle[]>();
  for (const symbol of cfg.market.symbols) {
    perSymbol.set(symbol, fetchTape(candles, symbol, interval, fetchFrom, opts.toTs));
  }
  const merged = [...perSymbol.values()].flat().sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));

  const inWindow = merged.filter((c) => c.ts >= opts.fromTs);
  const expectedBars = Math.floor((opts.toTs - opts.fromTs) / INTERVAL_MS[interval]) * cfg.market.symbols.length;
  const coveragePct = expectedBars > 0 ? Math.min(100, (inWindow.length / expectedBars) * 100) : 0;
  if (inWindow.length < 30) {
    throw new BacktestError(
      `not enough ${interval} history: have ${inWindow.length} bars in the window, need at least 30`,
    );
  }
  const warnings: string[] = [];
  const effectiveFrom = Math.max(opts.fromTs, inWindow[0].ts);
  if (coveragePct < 90) {
    warnings.push(
      `only ${coveragePct.toFixed(0)}% of the requested window has ${interval} data — results cover the available range`,
    );
  }

  const strategy = new DslStrategy(cfg);
  const ctx = new BacktestContext(interval, cfg.capital.initialBalanceUsd);
  for (const [symbol, tape] of perSymbol) ctx.loadSymbol(symbol, tape);

  const trades: BacktestTrade[] = [];
  const equity: { ts: number; equityUsd: number }[] = [];
  let peakMicro = 0;
  let maxDd = 0;

  const applyIntent = (intent: Intent, candle: Candle) => {
    const mark = candle.c;
    if (intent.action === 'buy') {
      const notional = intent.notionalUsd ?? 0;
      if (notional <= 0 || notional > ctx.cashUsd || mark <= 0) return;
      const qty = notional / mark; // engine computes qty at pre-slippage mark
      const fillPrice = mark * (1 + PAPER.majorSlippageBps / 10_000);
      const feeMicro = toMicro((qty * fillPrice * PAPER.feeBps) / 10_000);
      const pos = ctx.positions.find((p) => p.symbol === candle.symbol);
      if (pos) {
        const newQty = pos.qty + qty;
        pos.avgEntry = (pos.avgEntry * pos.qty + fillPrice * qty) / newQty;
        pos.qty = newQty;
      } else {
        ctx.positions.push({ id: ctx.nextPosId(), symbol: candle.symbol, qty, avgEntry: fillPrice, openedAt: ctx.now });
      }
      ctx.cashMicro -= toMicro(qty * fillPrice) + feeMicro;
      trades.push({
        ts: ctx.now, symbol: candle.symbol, side: 'buy', qty, price: fillPrice,
        feeUsd: fromMicro(feeMicro), realizedPnlUsd: 0, reason: intent.reason,
      });
      ctx.recordTrade(candle.symbol);
    } else {
      const idx = ctx.positions.findIndex((p) => p.symbol === intent.symbol);
      if (idx === -1) return;
      const pos = ctx.positions[idx];
      const sellQty = intent.qty !== undefined ? Math.min(intent.qty, pos.qty) : pos.qty;
      if (sellQty <= 0) return;
      const fillPrice = mark * (1 - PAPER.majorSlippageBps / 10_000);
      const feeMicro = toMicro((sellQty * fillPrice * PAPER.feeBps) / 10_000);
      const realizedMicro = toMicro(sellQty * (fillPrice - pos.avgEntry)) - feeMicro;
      const remaining = pos.qty - sellQty;
      if (remaining <= 1e-9) ctx.positions.splice(idx, 1);
      else pos.qty = remaining;
      ctx.cashMicro += toMicro(sellQty * fillPrice) - feeMicro;
      trades.push({
        ts: ctx.now, symbol: intent.symbol, side: 'sell', qty: sellQty, price: fillPrice,
        feeUsd: fromMicro(feeMicro), realizedPnlUsd: fromMicro(realizedMicro), reason: intent.reason,
      });
      ctx.recordTrade(intent.symbol);
    }
    ctx.cashUsd = fromMicro(ctx.cashMicro);
  };

  let processed = 0;
  for (const candle of merged) {
    ctx.advance(candle);
    if (candle.ts >= opts.fromTs) {
      const intents = strategy.onCandle(ctx, candle);
      for (const intent of intents) applyIntent(intent, candle);
      // equity mark: cash + positions at each symbol's latest close
      let posMicro = 0;
      for (const p of ctx.positions) posMicro += toMicro(p.qty * (ctx.mark(p.symbol) ?? p.avgEntry));
      const eqMicro = ctx.cashMicro + posMicro;
      equity.push({ ts: candle.ts, equityUsd: fromMicro(eqMicro) });
      peakMicro = Math.max(peakMicro, eqMicro);
      if (peakMicro > 0) maxDd = Math.max(maxDd, ((peakMicro - eqMicro) / peakMicro) * 100);
    }
    if (++processed % 500 === 0) await new Promise((r) => setImmediate(r));
  }

  const finalEquityUsd = equity.length ? equity[equity.length - 1].equityUsd : cfg.capital.initialBalanceUsd;
  const pnlUsd = finalEquityUsd - cfg.capital.initialBalanceUsd;
  const sells = trades.filter((t) => t.side === 'sell');
  const wins = sells.filter((t) => t.realizedPnlUsd > 0).length;

  // benchmark: BTC buy & hold over the same effective window
  const btc = candles.historyRange('BTCUSDT', interval, effectiveFrom, opts.toTs);
  let buyHold: BacktestResult['buyHold'] = { pnlPct: 0, curve: [] };
  if (btc.length > 1) {
    const base = btc[0].c;
    const curve = btc.map((c) => ({ ts: c.ts, equityUsd: cfg.capital.initialBalanceUsd * (c.c / base) }));
    buyHold = {
      pnlPct: ((btc[btc.length - 1].c - base) / base) * 100,
      curve: downsample(curve, 200),
    };
  }

  return {
    effectiveWindow: {
      fromTs: effectiveFrom, toTs: opts.toTs, interval,
      bars: inWindow.length, coveragePct: Math.round(coveragePct),
    },
    warnings,
    initialBalanceUsd: cfg.capital.initialBalanceUsd,
    finalEquityUsd,
    pnlUsd,
    pnlPct: (pnlUsd / cfg.capital.initialBalanceUsd) * 100,
    tradeCount: trades.length,
    winRate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
    maxDrawdownPct: maxDd,
    estimatedTradeTaxUsd: trades.length * FEES.tradeTaxUsd,
    trades: trades.slice(-500),
    equityCurve: downsample(equity, 200),
    buyHold,
  };
}

/** stored candles for 1m/1h; 5m/15m aggregated from 1m on the fly */
function fetchTape(
  candles: CandleStore,
  symbol: string,
  interval: Interval,
  fromTs: number,
  toTs: number,
): Candle[] {
  if (interval !== '5m' && interval !== '15m') {
    return candles.historyRange(symbol, interval, fromTs, toTs);
  }
  const bucketMs = INTERVAL_MS[interval];
  const m1 = candles.historyRange(symbol, '1m', Math.floor(fromTs / bucketMs) * bucketMs, toTs);
  const buckets = new Map<number, Candle>();
  for (const c of m1) {
    const bucket = Math.floor(c.ts / bucketMs) * bucketMs;
    const cur = buckets.get(bucket);
    if (!cur) {
      buckets.set(bucket, { ...c, interval, ts: bucket });
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  return [...buckets.values()].filter((c) => c.ts >= fromTs - bucketMs).sort((a, b) => a.ts - b.ts);
}

function downsample<T>(points: T[], target: number): T[] {
  if (points.length <= target) return points;
  const stride = Math.floor(points.length / target);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/** resolve a UI window ('24h'|'7d'|'30d'|'90d') into fromTs/toTs, enforcing data-honesty rules */
export function resolveWindow(cfg: StrategyConfig, window: string): { fromTs: number; toTs: number } {
  const now = Date.now();
  const days = window === '24h' ? 1 : window === '7d' ? 7 : window === '30d' ? 30 : 90;
  if (days > 7 && cfg.market.interval !== '1h') {
    throw new BacktestError(
      `30d/90d backtests need interval '1h' — 1m candles are pruned at 7 days. Run 7d, or rebuild the strategy on 1h candles.`,
    );
  }
  return { fromTs: now - days * 86_400_000, toTs: now };
}
