import type { Candle } from '@punklabz/shared';
import type { ConditionNode, IndicatorCondition, StrategyConfig } from '@punklabz/shared';
import { atr, bollinger, crossAbove, crossBelow, ema, priceChangePct, rsi, sma } from '../indicators.js';
import type { Intent, Strategy, StrategyContext } from './strategy.js';

/**
 * Interprets a validated StrategyConfig (the no-code builder's output) so quant
 * bots run on the exact same engine as house bots. Long-only, market orders.
 */
export class DslStrategy implements Strategy {
  readonly type = 'dsl';
  constructor(private cfg: StrategyConfig) {}

  subscriptions() {
    return { symbols: this.cfg.market.symbols as string[], interval: this.cfg.market.interval };
  }

  onCandle(ctx: StrategyContext, candle: Candle): Intent[] {
    const { cfg } = this;
    if (candle.interval !== cfg.market.interval) return [];
    if (!(cfg.market.symbols as string[]).includes(candle.symbol)) return [];

    const hist = ctx.history(candle.symbol);
    if (hist.length < 5) return [];
    const pos = ctx.positions.find((p) => p.symbol === candle.symbol);

    if (pos) {
      // risk block first (hard rules), then the user's exit tree
      const pnlPct = ((candle.c - pos.avgEntry) / pos.avgEntry) * 100;
      if (pnlPct <= -cfg.risk.stopLossPct)
        return [{ action: 'sell', symbol: candle.symbol, reason: `risk stop ${pnlPct.toFixed(1)}%` }];
      if (cfg.risk.takeProfitPct !== undefined && pnlPct >= cfg.risk.takeProfitPct)
        return [{ action: 'sell', symbol: candle.symbol, reason: `risk tp +${pnlPct.toFixed(1)}%` }];
      if (
        cfg.risk.maxHoldMinutes !== undefined &&
        ctx.now - pos.openedAt > cfg.risk.maxHoldMinutes * 60_000
      )
        return [{ action: 'sell', symbol: candle.symbol, reason: 'risk max hold' }];
      if (this.evalNode(cfg.exit, hist, pos.avgEntry, ctx.now - pos.openedAt))
        return [{ action: 'sell', symbol: candle.symbol, reason: 'exit conditions met' }];
      return [];
    }

    // entry gates
    if (ctx.positions.length >= cfg.capital.maxOpenPositions) return [];
    if (ctx.minutesSinceLastTrade(candle.symbol) < cfg.risk.cooldownMinutes) return [];
    if (ctx.tradesToday() >= cfg.risk.maxTradesPerDay) return [];
    if (!this.evalNode(cfg.entry, hist, null, 0)) return [];

    const notional = (ctx.cashUsd * cfg.capital.positionSizePct) / 100;
    if (notional < 10) return [];
    return [{ action: 'buy', symbol: candle.symbol, notionalUsd: notional, reason: 'entry conditions met' }];
  }

  private evalNode(
    node: ConditionNode,
    hist: Candle[],
    avgEntry: number | null,
    heldMs: number,
  ): boolean {
    if ('all' in node) return node.all.every((c) => this.evalNode(c, hist, avgEntry, heldMs));
    if ('any' in node) return node.any.some((c) => this.evalNode(c, hist, avgEntry, heldMs));
    if ('not' in node) return !this.evalNode(node.not, hist, avgEntry, heldMs);
    if (node.kind === 'risk') {
      if (avgEntry === null) return false; // risk leaves only make sense in exits
      const price = hist[hist.length - 1].c;
      const pnlPct = ((price - avgEntry) / avgEntry) * 100;
      switch (node.type) {
        case 'takeProfitPct': return pnlPct >= node.value;
        case 'stopLossPct': return pnlPct <= -node.value;
        case 'maxHoldMinutes': return heldMs > node.value * 60_000;
        case 'trailingStopPct': return false; // handled by the risk block; leaf form unsupported
      }
    }
    return this.evalIndicator(node, hist);
  }

  private indicatorValue(
    name: IndicatorCondition['indicator'],
    hist: Candle[],
    period?: number,
    lookbackBars?: number,
  ): number | null {
    const closes = hist.map((c) => c.c);
    const vols = hist.map((c) => c.v);
    switch (name) {
      case 'price': return closes[closes.length - 1] ?? null;
      case 'volume': return vols[vols.length - 1] ?? null;
      case 'sma': return sma(closes, period ?? 20);
      case 'ema': return ema(closes, period ?? 20);
      case 'rsi': return rsi(closes, period ?? 14);
      case 'bollingerUpper': return bollinger(closes, period ?? 20)?.upper ?? null;
      case 'bollingerLower': return bollinger(closes, period ?? 20)?.lower ?? null;
      case 'bollingerWidth': return bollinger(closes, period ?? 20)?.width ?? null;
      case 'atr': return atr(hist, period ?? 14);
      case 'volumeSma': return sma(vols, period ?? 20);
      case 'priceChangePct': return priceChangePct(closes, lookbackBars ?? 1);
    }
  }

  /** value series for cross ops (evaluated on last two bars) */
  private indicatorSeries(
    name: IndicatorCondition['indicator'],
    hist: Candle[],
    period?: number,
    lookbackBars?: number,
  ): number[] {
    const out: number[] = [];
    for (const n of [hist.length - 1, hist.length]) {
      const v = this.indicatorValue(name, hist.slice(0, n), period, lookbackBars);
      if (v !== null) out.push(v);
    }
    return out;
  }

  private evalIndicator(node: IndicatorCondition, hist: Candle[]): boolean {
    if (node.op === 'crossAbove' || node.op === 'crossBelow') {
      const left = this.indicatorSeries(node.indicator, hist, node.period, node.lookbackBars);
      const right = node.valueRef
        ? this.indicatorSeries(node.valueRef.indicator, hist, node.valueRef.period, node.valueRef.lookbackBars)
        : [node.value ?? 0, node.value ?? 0];
      if (left.length < 2 || right.length < 2) return false;
      return node.op === 'crossAbove' ? crossAbove(left, right) : crossBelow(left, right);
    }
    const left = this.indicatorValue(node.indicator, hist, node.period, node.lookbackBars);
    if (left === null) return false;
    const right = node.valueRef
      ? this.indicatorValue(node.valueRef.indicator, hist, node.valueRef.period, node.valueRef.lookbackBars)
      : node.value;
    if (right === null || right === undefined) return false;
    switch (node.op) {
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'gt': return left > right;
      case 'gte': return left >= right;
    }
  }
}
