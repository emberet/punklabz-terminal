import type { Candle, Interval } from '@punklabz/shared';
import type { OpenPosition } from '../accounting.js';

export interface PumpTokenStats {
  mint: string;
  name: string | null;
  symbol: string | null;
  launchedAt: number;
  lastPriceSol: number;
  buys60s: number;
  vol60s: number;
  uniqueBuyers60s: number;
}

export interface StrategyContext {
  botId: number;
  now: number;
  cashUsd: number;
  initialBalanceUsd: number;
  positions: OpenPosition[];
  /** candle history oldest-first for a symbol at the strategy's interval */
  history(symbol: string, interval?: Interval): Candle[];
  mark(symbol: string): number | undefined;
  /** minutes since this bot's last trade on symbol (Infinity if never) */
  minutesSinceLastTrade(symbol: string): number;
  tradesToday(): number;
}

export interface Intent {
  action: 'buy' | 'sell';
  symbol: string;
  /** for buys: USD notional to spend; for sells: qty (defaults to full position) */
  notionalUsd?: number;
  qty?: number;
  orderType?: 'market' | 'limit';
  limitPrice?: number;
  reason: string;
}

export interface Strategy {
  readonly type: string;
  /** symbols + interval this strategy wants candleClosed events for; pump strategies return [] */
  subscriptions(): { symbols: string[]; interval: Interval };
  onCandle(ctx: StrategyContext, candle: Candle): Intent[];
  /** 1s timer tick — used by pump strategies for time-based exits; optional */
  onTimer?(ctx: StrategyContext): Intent[];
  /** pump.fun events; optional */
  onPumpLaunch?(ctx: StrategyContext, token: PumpTokenStats): Intent[];
  onPumpUpdate?(ctx: StrategyContext, token: PumpTokenStats): Intent[];
}
