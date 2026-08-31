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
  /**
   * Ceiling on the gap between the quoted fill and the minimum the swap will
   * accept, enforced in the calldata that gets signed — not measured after the
   * fact. Optional so an existing limits_json row keeps its old behaviour
   * rather than silently loosening to a new default.
   */
  maxSlippageBps?: number;
}

/** capital exposed at each rollout stage — promotion is deliberate, never automatic */
export const CAPITAL_STAGES = [0, 5, 20, 50, 100] as const;

/** below this an order costs more in fees than the edge is worth */
export const MIN_TRADE_USD = 0.5;

export const DEFAULT_LIMITS: RiskLimits = {
  totalCapitalUsd: 100,
  maxPerTradePct: 10,
  maxPerMachinePct: 15,
  maxSimultaneousPositions: 4,
  maxCorrelatedExposurePct: 25,
  maxDailyLossPct: 5,
  maxTotalDrawdownPct: 10,
  minCashReservePct: 30,
  leverageMax: 1,
  confidenceThreshold: 90,
  maxSlippageBps: 35,
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
  /**
   * Set ONLY by an audited operator force. It overrides the confidence gate —
   * the check that asks "did a strategy believe this?" — and nothing else.
   * Every check that protects funds (notional cap, open positions, daily loss,
   * drawdown, cash reserve, correlated exposure) still runs and can still
   * reject. The override is written into the order's risk_json, so a forced
   * order is distinguishable from an earned one forever.
   */
  forcedBy?: string;
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
  | 'submitted'
  | 'pending'
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
  /** admin-only; public status does not expose exact risk policy */
  limits?: RiskLimits;
  nav: { totalUsd: number; deployedUsd: number; availableUsd: number; reserveUsd: number };
  today: { netPnlUsd: number; feesUsd: number; drawdownPct: number };
  throughput: { marketsWatched: number; signals: number; approved: number; executed: number; rejected: number };
  liveSignerConfigured?: boolean;

  // ── the execution boundary ──
  // Admin status measures signer/adapter/balances at request time. Public status
  // omits custody and signer fields and serves only coarse local health.
  network: string;
  chainId: number;
  settlementSymbol: string;
  signer?: { kind: string; ready: boolean; address: string | null; detail: string };
  walletAddress?: string | null;
  adapterStatus: string;
  settlementBalance?: number | null;
  ethGasBalance?: number | null;
  baseAssetBalance?: number | null;
  authorizedCapitalUsd?: number;
  pendingTransactions?: number;
  promotion?: {
    cleanFills: number;
    reconciliationClean: boolean;
    failedOrders: number;
    collateralizedUsdg: number;
  };
  lastReconciliation?: { at: number; clean: boolean } | null;
  preflightStatus?: { at: number; mode: string; passed: boolean } | null;
}

export interface CompositeConfidence {
  strategy: number;
  regime: number;
  liquidity: number;
  cost: number;
  confirmation: number;
  composite: number;
}
