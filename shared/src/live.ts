// Live-execution network: shared types. The unified instrument model lets
// strategies reason about any market without hardcoding a venue's API.

export type AssetClass =
  | 'CRYPTO_SPOT'
  | 'CRYPTO_PERP'
  | 'STOCK'
  | 'ETF'
  | 'FOREX'
  | 'FUTURE'
  | 'INDEX'
  | 'PREDICTION';

export interface Instrument {
  id: string; // canonical, e.g. CRYPTO_SPOT://binance/BTCUSDT
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  venue: string;
  network: string | null;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  minNotionalUsd: number;
  leverageAllowed: number; // 1 = no leverage
  tradable: boolean; // false = data/registry only, no execution path in this build
  note?: string;
}

export type ExecutionMode = 'simulation' | 'shadow' | 'canary' | 'live';

export interface RiskLimits {
  totalCapitalUsd: number;
  maxPerTradePct: number;
  maxPerMachinePct: number;
  maxSimultaneousPositions: number;
  maxCorrelatedExposurePct: number;
  maxDailyLossPct: number;
  maxTotalDrawdownPct: number;
  minCashReservePct: number;
  leverageMax: number; // 1 = disabled
  confidenceThreshold: number; // 0-100 composite gate
}

/** capital exposed at each rollout stage — promotion is deliberate, never automatic */
export const CAPITAL_STAGES = [0, 5, 20, 50, 100] as const;

/** below this an order costs more in fees than the edge is worth */
export const MIN_TRADE_USD = 0.5;

export const DEFAULT_LIMITS: RiskLimits = {
  totalCapitalUsd: 100,
  maxPerTradePct: 5,
  maxPerMachinePct: 15,
  maxSimultaneousPositions: 4,
  maxCorrelatedExposurePct: 25,
  maxDailyLossPct: 5,
  maxTotalDrawdownPct: 10,
  minCashReservePct: 30,
  leverageMax: 1,
  confidenceThreshold: 90,
};

export interface OrderIntent {
  intentId: string;
  botId: number | null;
  instrumentId: string;
  venue: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  confidence: number;
  reason: string;
}

export interface RiskCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RiskDecision {
  approved: boolean;
  sizeUsd: number;
  rejectionReason: string | null;
  checks: RiskCheck[];
}

export type OrderState =
  | 'proposed'
  | 'risk_approved'
  | 'risk_rejected'
  | 'submitting'
  | 'open'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'failed'
  | 'reconciling';

export type VenueStatus = 'online' | 'degraded' | 'offline';

export interface VenueHealth {
  venue: string;
  status: VenueStatus;
  latencyMs: number | null;
  errorRate: number;
  lastOkAt: number | null;
  note: string | null;
}

export interface LiveStatusView {
  mode: ExecutionMode;
  halted: boolean;
  haltReason: string | null;
  capitalStage: number;
  stageCapUsd: number;
  limits: RiskLimits;
  nav: { totalUsd: number; deployedUsd: number; availableUsd: number; reserveUsd: number };
  today: { netPnlUsd: number; feesUsd: number; drawdownPct: number };
  throughput: { marketsWatched: number; signals: number; approved: number; executed: number; rejected: number };
  liveSignerConfigured: boolean;
}

export interface CompositeConfidence {
  strategy: number;
  regime: number;
  liquidity: number;
  cost: number;
  confirmation: number;
  composite: number;
}
