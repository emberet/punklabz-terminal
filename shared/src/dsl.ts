import { z } from 'zod';

// ── Strategy DSL ─────────────────────────────────────────────────────────────
// Declarative config the no-code builder produces and dslStrategy.ts interprets.
// Claude fills this schema via tool call; it never writes executable code.

export const INDICATORS = [
  'price',
  'volume',
  'sma',
  'ema',
  'rsi',
  'bollingerUpper',
  'bollingerLower',
  'bollingerWidth',
  'atr',
  'volumeSma',
  'priceChangePct',
] as const;

export const OPS = ['lt', 'lte', 'gt', 'gte', 'crossAbove', 'crossBelow'] as const;

const indicatorRef = z.object({
  indicator: z.enum(INDICATORS),
  period: z.number().int().min(2).max(200).optional(),
  lookbackBars: z.number().int().min(1).max(200).optional(),
});

export const indicatorCondition = z.object({
  kind: z.literal('indicator'),
  indicator: z.enum(INDICATORS),
  period: z.number().int().min(2).max(200).optional(),
  lookbackBars: z.number().int().min(1).max(200).optional(),
  op: z.enum(OPS),
  value: z.number().optional(),
  valueRef: indicatorRef.optional(),
});

export const riskCondition = z.object({
  kind: z.literal('risk'),
  type: z.enum(['takeProfitPct', 'stopLossPct', 'maxHoldMinutes', 'trailingStopPct']),
  value: z.number().positive(),
});

export type IndicatorCondition = z.infer<typeof indicatorCondition>;
export type RiskCondition = z.infer<typeof riskCondition>;

export type ConditionNode =
  | IndicatorCondition
  | RiskCondition
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode };

const conditionNode: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    indicatorCondition,
    riskCondition,
    z.object({ all: z.array(conditionNode).min(1).max(10) }),
    z.object({ any: z.array(conditionNode).min(1).max(10) }),
    z.object({ not: conditionNode }),
  ]),
);

export const strategyConfigSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(60),
  market: z.object({
    venue: z.enum(['binance', 'coinbase']),
    symbols: z.array(z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])).min(1).max(3),
    interval: z.enum(['1m', '5m', '15m', '1h']),
  }),
  capital: z.object({
    initialBalanceUsd: z.number().int().min(1000).max(100000).default(10000),
    positionSizePct: z.number().min(1).max(25),
    maxOpenPositions: z.number().int().min(1).max(5),
  }),
  entry: conditionNode,
  exit: conditionNode,
  risk: z.object({
    stopLossPct: z.number().min(0.5).max(50),
    takeProfitPct: z.number().min(0.5).max(500).optional(),
    trailingStopPct: z.number().min(0.5).max(50).optional(),
    cooldownMinutes: z.number().min(1).max(1440),
    maxTradesPerDay: z.number().int().min(1).max(100),
    maxHoldMinutes: z.number().int().min(1).max(10080).optional(),
  }),
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

/** Depth + leaf-count limits (zod can't express tree depth cleanly). */
export function lintConditionTree(node: ConditionNode, depth = 0): string[] {
  const errors: string[] = [];
  if (depth > 3) {
    errors.push('condition tree exceeds max depth of 3');
    return errors;
  }
  if ('all' in node) node.all.forEach((c) => errors.push(...lintConditionTree(c, depth + 1)));
  else if ('any' in node) node.any.forEach((c) => errors.push(...lintConditionTree(c, depth + 1)));
  else if ('not' in node) errors.push(...lintConditionTree(node.not, depth + 1));
  else if (node.kind === 'indicator') {
    if (node.value === undefined && node.valueRef === undefined)
      errors.push(`indicator condition on ${node.indicator} needs value or valueRef`);
    if (node.value !== undefined && node.valueRef !== undefined)
      errors.push(`indicator condition on ${node.indicator} cannot have both value and valueRef`);
    const needsPeriod = ['sma', 'ema', 'rsi', 'bollingerUpper', 'bollingerLower', 'bollingerWidth', 'atr', 'volumeSma'];
    if (needsPeriod.includes(node.indicator) && node.period === undefined)
      errors.push(`${node.indicator} requires a period`);
    if (node.indicator === 'priceChangePct' && node.lookbackBars === undefined)
      errors.push('priceChangePct requires lookbackBars');
  }
  return errors;
}

export function countLeaves(node: ConditionNode): number {
  if ('all' in node) return node.all.reduce((n, c) => n + countLeaves(c), 0);
  if ('any' in node) return node.any.reduce((n, c) => n + countLeaves(c), 0);
  if ('not' in node) return countLeaves(node.not);
  return 1;
}

/** Full semantic lint: run after zod parse succeeds. Returns [] when clean. */
export function lintStrategyConfig(cfg: StrategyConfig): string[] {
  const errors: string[] = [];
  errors.push(...lintConditionTree(cfg.entry).map((e) => `entry: ${e}`));
  errors.push(...lintConditionTree(cfg.exit).map((e) => `exit: ${e}`));
  if (countLeaves(cfg.entry) > 10) errors.push('entry: more than 10 conditions');
  if (countLeaves(cfg.exit) > 10) errors.push('exit: more than 10 conditions');
  return errors;
}
