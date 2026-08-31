// Net-edge accounting. The single most important gate in the system:
//
//   NET EDGE = EXPECTED EDGE − FEES − SLIPPAGE − SAFETY BUFFER
//
// EXPECTED EDGE is a MODEL ESTIMATE derived from measured volatility, never a
// prediction and never a promise. Every estimate carries the name of the model
// that produced it so a human can audit where the number came from.

export interface EdgeModelInput {
  /** measured ATR as a % of price over the signal's timeframe */
  atrPct: number;
  /** fraction of ATR a favorable excursion is assumed to capture */
  captureRatio: number;
  /** venue taker fee, round trip */
  feeBps: number;
  /** modeled execution slippage, round trip */
  slippageBps: number;
  /** required margin of safety on top of costs */
  bufferBps: number;
}

export interface EdgeBreakdown {
  grossEdgeBps: number;
  feeBps: number;
  slippageBps: number;
  bufferBps: number;
  netEdgeBps: number;
  edgeModel: string;
  viable: boolean;
}

/** cost model per universe — real venue economics, conservative by design */
export const COST_MODEL = {
  majors: { feeBps: 20, slippageBps: 10, bufferBps: 10 }, // round-trip 10bps fee + 5bps slip each way
  pumpfun: { feeBps: 200, slippageBps: 300, bufferBps: 100 }, // launch liquidity is brutal
  multichain: { feeBps: 60, slippageBps: 80, bufferBps: 40 }, // DEX + gas on small size
} as const;

export type Universe = keyof typeof COST_MODEL;

/**
 * ATR-excursion estimate: over the next N bars a favorable move of
 * captureRatio × ATR is assumed reachable. Named `atr_excursion_<ratio>x`.
 * This is the honest way to state "how much is theoretically on the table"
 * without pretending to forecast direction — direction comes from the signal,
 * magnitude from measured volatility.
 */
export function estimateEdge(input: EdgeModelInput): EdgeBreakdown {
  const grossEdgeBps = Math.max(0, input.atrPct * input.captureRatio * 100);
  const netEdgeBps = grossEdgeBps - input.feeBps - input.slippageBps - input.bufferBps;
  return {
    grossEdgeBps,
    feeBps: input.feeBps,
    slippageBps: input.slippageBps,
    bufferBps: input.bufferBps,
    netEdgeBps,
    edgeModel: `atr_excursion_${input.captureRatio}x`,
    viable: netEdgeBps > 0,
  };
}

export function edgeForUniverse(universe: Universe, atrPct: number, captureRatio = 0.5): EdgeBreakdown {
  const costs = COST_MODEL[universe];
  return estimateEdge({ atrPct, captureRatio, ...costs });
}

/** human-readable rejection block, exactly as the terminal renders it */
export function edgeLines(e: EdgeBreakdown): string[] {
  const pct = (bps: number) => `${bps >= 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(2)}%`;
  return [
    `EXPECTED EDGE     ${pct(e.grossEdgeBps)}`,
    `FEES              ${pct(-e.feeBps)}`,
    `SLIPPAGE          ${pct(-e.slippageBps)}`,
    `SAFETY BUFFER     ${pct(-e.bufferBps)}`,
    `NET EDGE          ${pct(e.netEdgeBps)}`,
  ];
}
