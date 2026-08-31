import type { ConditionNode, IndicatorCondition, RiskCondition, StrategyConfig } from '@punklabz/shared';

// Translate the strategy DSL into readable English for the visual config
// preview — quants should never have to parse raw JSON.

const IND_NAMES: Record<string, string> = {
  price: 'Price',
  volume: 'Volume',
  sma: 'SMA',
  ema: 'EMA',
  rsi: 'RSI',
  bollingerUpper: 'Upper Bollinger',
  bollingerLower: 'Lower Bollinger',
  bollingerWidth: 'Bollinger width',
  atr: 'ATR',
  volumeSma: 'Volume SMA',
  priceChangePct: 'Price change %',
};

const OP_TEXT: Record<string, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  crossAbove: 'crosses above',
  crossBelow: 'crosses below',
};

function indName(name: string, period?: number, lookback?: number): string {
  const base = IND_NAMES[name] ?? name;
  if (period !== undefined) return `${base}(${period})`;
  if (lookback !== undefined) return `${base} over ${lookback} bars`;
  return base;
}

function leafText(node: IndicatorCondition | RiskCondition): string {
  if (node.kind === 'risk') {
    switch (node.type) {
      case 'takeProfitPct': return `Profit reaches +${node.value}%`;
      case 'stopLossPct': return `Loss reaches −${node.value}%`;
      case 'maxHoldMinutes': return `Held longer than ${node.value} min`;
      case 'trailingStopPct': return `Drops ${node.value}% off its peak`;
    }
  }
  const left = indName(node.indicator, node.period, node.lookbackBars);
  const right = node.valueRef
    ? indName(node.valueRef.indicator, node.valueRef.period, node.valueRef.lookbackBars)
    : String(node.value);
  return `${left} ${OP_TEXT[node.op]} ${right}`;
}

/** Flatten a condition tree into lines joined by AND/OR markers. */
export function conditionLines(node: ConditionNode, depth = 0): { text: string; joiner: 'AND' | 'OR' | null }[] {
  if ('all' in node) {
    return node.all.flatMap((c, i) =>
      conditionLines(c, depth + 1).map((l, j) => ({
        ...l,
        joiner: i > 0 && j === 0 ? ('AND' as const) : l.joiner,
      })),
    );
  }
  if ('any' in node) {
    return node.any.flatMap((c, i) =>
      conditionLines(c, depth + 1).map((l, j) => ({
        ...l,
        joiner: i > 0 && j === 0 ? ('OR' as const) : l.joiner,
      })),
    );
  }
  if ('not' in node) {
    return conditionLines(node.not, depth + 1).map((l) => ({ ...l, text: `NOT ${l.text}` }));
  }
  return [{ text: leafText(node), joiner: null }];
}

export interface StrategySummary {
  market: string;
  entry: { text: string; joiner: 'AND' | 'OR' | null }[];
  exit: { text: string; joiner: 'AND' | 'OR' | null }[];
  risk: string[];
  sizing: string;
}

export function describeStrategy(cfg: StrategyConfig): StrategySummary {
  const risk: string[] = [`Stop loss −${cfg.risk.stopLossPct}%`];
  if (cfg.risk.takeProfitPct !== undefined) risk.push(`Take profit +${cfg.risk.takeProfitPct}%`);
  if (cfg.risk.trailingStopPct !== undefined) risk.push(`Trailing stop ${cfg.risk.trailingStopPct}%`);
  risk.push(`Cooldown ${cfg.risk.cooldownMinutes} min`);
  risk.push(`Max ${cfg.risk.maxTradesPerDay} trades/day`);
  if (cfg.risk.maxHoldMinutes !== undefined) risk.push(`Max hold ${cfg.risk.maxHoldMinutes} min`);
  return {
    market: `${cfg.market.symbols.map((s) => s.replace('USDT', '')).join(' · ')} on ${cfg.market.interval} candles`,
    entry: conditionLines(cfg.entry),
    exit: conditionLines(cfg.exit),
    risk,
    sizing: `${cfg.capital.positionSizePct}% of balance per position · max ${cfg.capital.maxOpenPositions} open`,
  };
}
