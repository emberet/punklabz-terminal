import type { Candle, Interval } from '@punklabz/shared';
import type { Intent, Strategy, StrategyContext } from './strategy.js';

export interface GridConfig {
  symbols: string[];
  interval: Interval;
  gridLevels: number;   // ladder rungs below the anchor
  gridSpanPct: number;  // ladder spans anchor-gridSpanPct% .. anchor
  positionSizePct: number; // max notional per symbol as % of initial balance
  minTicketUsd: number; // ignore rebalances smaller than this
}

export const GRID_DEFAULTS: GridConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  interval: '1m',
  gridLevels: 10,
  gridSpanPct: 3,
  positionSizePct: 20,
  minTicketUsd: 25,
};

/**
 * Grid Trader as a ladder rebalance: anchor = daily open (00:00 UTC), rungs
 * spaced evenly across the span below it. The deeper price sits under the
 * anchor, the larger the target position; price recovering unwinds the ladder
 * rung by rung, harvesting the swings. Anchor derives from candle history, so
 * restarts need no extra state and no resting orders.
 */
export class GridStrategy implements Strategy {
  readonly type = 'grid';
  // A DEFAULT PARAMETER ONLY FIRES ON `undefined`.
  //
  // Every house bot stores config_json = '{}', and `{}` is a real value, so it
  // REPLACED the defaults instead of falling back to them. cfg.interval became
  // undefined, the first line of onCandle compared it to the candle's interval,
  // and the strategy returned no intents — silently, with no error, forever.
  // Five of the seven house machines had never placed a single order.
  //
  // Merging rather than defaulting makes a partial config mean what everyone
  // reading the call site assumed it meant.
  private readonly cfg: GridConfig;
  constructor(cfg: Partial<GridConfig> = {}) {
    this.cfg = { ...GRID_DEFAULTS, ...cfg };
  }

  subscriptions() {
    return { symbols: this.cfg.symbols, interval: this.cfg.interval };
  }

  private anchorFor(ctx: StrategyContext, symbol: string, now: number): number | null {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const hist = ctx.history(symbol);
    // first candle at/after today's UTC open
    const first = hist.find((c) => c.ts >= dayStart);
    if (first) return first.o;
    // before any candle today: fall back to latest close
    return hist.length ? hist[hist.length - 1].c : null;
  }

  onCandle(ctx: StrategyContext, candle: Candle): Intent[] {
    const { cfg } = this;
    if (candle.interval !== cfg.interval || !cfg.symbols.includes(candle.symbol)) return [];
    const anchor = this.anchorFor(ctx, candle.symbol, candle.ts);
    if (anchor === null || anchor <= 0) return [];

    const price = candle.c;
    const drawdownPct = ((anchor - price) / anchor) * 100;
    const step = cfg.gridSpanPct / cfg.gridLevels;
    const levelsBelow = Math.max(0, Math.min(cfg.gridLevels, Math.floor(drawdownPct / step)));

    const maxNotional = (ctx.initialBalanceUsd * cfg.positionSizePct) / 100;
    const targetNotional = (maxNotional * levelsBelow) / cfg.gridLevels;
    const pos = ctx.positions.find((p) => p.symbol === candle.symbol);
    const currentNotional = pos ? pos.qty * price : 0;
    const diff = targetNotional - currentNotional;

    if (diff > cfg.minTicketUsd && ctx.cashUsd > diff) {
      return [{
        action: 'buy',
        symbol: candle.symbol,
        notionalUsd: diff,
        reason: `grid rung ${levelsBelow}/${cfg.gridLevels} (-${drawdownPct.toFixed(2)}% vs anchor)`,
      }];
    }
    if (diff < -cfg.minTicketUsd && pos) {
      const sellQty = Math.min(pos.qty, -diff / price);
      return [{
        action: 'sell',
        symbol: candle.symbol,
        qty: sellQty,
        reason: `grid unwind to rung ${levelsBelow}/${cfg.gridLevels}`,
      }];
    }
    return [];
  }
}
