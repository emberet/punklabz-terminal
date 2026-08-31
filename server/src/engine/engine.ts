import { EventEmitter } from 'node:events';
import { strategyConfigSchema, type Candle, type Interval, type TradeView } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import type { Executor, Fill } from '../execution/executor.js';
import type { CandleStore } from '../feeds/candles.js';
import { fromMicro } from '../money.js';
import { applyFill, computeEquity, getOpenPositions, snapshotMetrics } from './accounting.js';
import type { Intent, PumpTokenStats, Strategy, StrategyContext } from './strategies/strategy.js';
import { MomentumStrategy } from './strategies/momentum.js';
import { MeanReversionStrategy } from './strategies/meanReversion.js';
import { GridStrategy } from './strategies/grid.js';
import { PumpSniperStrategy } from './strategies/pumpSniper.js';
import { HerdSentimentStrategy } from './strategies/herdSentiment.js';
import { DslStrategy } from './strategies/dslStrategy.js';

interface BotRow {
  id: number;
  owner_user_id: number | null;
  name: string;
  kind: 'house' | 'quant';
  strategy_type: string;
  config_json: string;
  status: 'running' | 'stopped' | 'paused';
}

interface RunningBot {
  row: BotRow;
  strategy: Strategy;
}

/**
 * The trading engine. Subscribes to closed candles and pump events, calls
 * strategies for intents, routes intents through the Executor, and books fills
 * via accounting. Emits:
 *   'trade'      (TradeView)                    every booked fill
 *   'botUpdate'  ({botId, equityUsd})           after fills + snapshots
 *   'botPaused'  ({botId, reason})
 */
export class Engine extends EventEmitter {
  private bots = new Map<number, RunningBot>();
  private feedStale = false;
  private timer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private candles: CandleStore,
    private executor: Executor,
  ) {
    super();
    this.executor.onFill((fill) => this.handleFill(fill));
    this.candles.on('candleClosed', (c: Candle) => this.onCandle(c));
  }

  start(): void {
    this.loadBots();
    this.timer = setInterval(() => this.onTimer(), 1000);
    this.snapshotTimer = setInterval(() => this.snapshotAll(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
  }

  setFeedStale(stale: boolean): void {
    this.feedStale = stale;
  }

  /**
   * (re)load bots from the DB — also called after quant deploys.
   * Paused bots stay loaded so exits can still fire; execute() drops their buys.
   */
  loadBots(): void {
    const rows = this.db
      .prepare(`SELECT id, owner_user_id, name, kind, strategy_type, config_json, status FROM bots WHERE status IN ('running','paused')`)
      .all() as BotRow[];
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      if (this.bots.has(row.id)) continue;
      const strategy = this.buildStrategy(row);
      if (strategy) this.bots.set(row.id, { row, strategy });
    }
    for (const id of this.bots.keys()) if (!seen.has(id)) this.bots.delete(id);
  }

  private buildStrategy(row: BotRow): Strategy | null {
    try {
      const cfg = JSON.parse(row.config_json);
      switch (row.strategy_type) {
        case 'momentum': return new MomentumStrategy(cfg);
        case 'mean_reversion': return new MeanReversionStrategy(cfg);
        case 'grid': return new GridStrategy(cfg);
        case 'pump_sniper': return new PumpSniperStrategy(cfg);
        case 'herd_sentiment': return new HerdSentimentStrategy(cfg);
        case 'dsl': return new DslStrategy(strategyConfigSchema.parse(cfg));
        default:
          console.error(`unknown strategy_type ${row.strategy_type} on bot ${row.id}`);
          return null;
      }
    } catch (e) {
      console.error(`bad config on bot ${row.id}:`, e);
      return null;
    }
  }

  private ctxFor(botId: number, interval: Interval): StrategyContext {
    const db = this.db;
    const account = db
      .prepare('SELECT cash_micro, initial_balance_micro FROM bot_accounts WHERE bot_id = ?')
      .get(botId) as { cash_micro: number; initial_balance_micro: number };
    const candles = this.candles;
    const executor = this.executor;
    return {
      botId,
      now: Date.now(),
      cashUsd: fromMicro(account.cash_micro),
      initialBalanceUsd: fromMicro(account.initial_balance_micro),
      positions: getOpenPositions(db, botId),
      history: (symbol, iv) => candles.history(symbol, iv ?? interval),
      mark: (symbol) => (executor as any).getMark?.(symbol),
      minutesSinceLastTrade: (symbol) => {
        const row = db
          .prepare('SELECT MAX(ts) AS ts FROM trades WHERE bot_id = ? AND symbol = ?')
          .get(botId, symbol) as { ts: number | null };
        return row.ts === null ? Infinity : (Date.now() - row.ts) / 60_000;
      },
      tradesToday: () => {
        const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
        const row = db
          .prepare('SELECT COUNT(*) AS n FROM trades WHERE bot_id = ? AND ts >= ?')
          .get(botId, dayStart) as { n: number };
        return row.n;
      },
    };
  }

  private onCandle(candle: Candle): void {
    this.executor.markPrice(candle.symbol, candle.c);
    if (this.feedStale) return; // no NEW entries on stale data; exits happen via timer/marks
    for (const bot of this.bots.values()) {
      // strategies filter by interval/symbol themselves
      try {
        const ctx = this.ctxFor(bot.row.id, bot.strategy.subscriptions().interval);
        const intents = bot.strategy.onCandle(ctx, candle);
        this.execute(bot, ctx, intents);
      } catch (e) {
        console.error(`bot ${bot.row.id} onCandle error:`, e);
      }
    }
  }

  private onTimer(): void {
    for (const bot of this.bots.values()) {
      if (!bot.strategy.onTimer) continue;
      try {
        const ctx = this.ctxFor(bot.row.id, bot.strategy.subscriptions().interval);
        this.execute(bot, ctx, bot.strategy.onTimer(ctx));
      } catch (e) {
        console.error(`bot ${bot.row.id} onTimer error:`, e);
      }
    }
  }

  pumpLaunch(token: PumpTokenStats): void {
    this.dispatchPump('onPumpLaunch', token);
  }

  pumpUpdate(token: PumpTokenStats): void {
    this.executor.markPrice(token.mint, token.lastPriceSol);
    this.dispatchPump('onPumpUpdate', token);
  }

  private dispatchPump(method: 'onPumpLaunch' | 'onPumpUpdate', token: PumpTokenStats): void {
    if (this.feedStale) return;
    for (const bot of this.bots.values()) {
      const fn = bot.strategy[method];
      if (!fn) continue;
      try {
        const ctx = this.ctxFor(bot.row.id, '1m');
        this.execute(bot, ctx, fn.call(bot.strategy, ctx, token));
      } catch (e) {
        console.error(`bot ${bot.row.id} ${method} error:`, e);
      }
    }
  }

  private execute(bot: RunningBot, ctx: StrategyContext, intents: Intent[]): void {
    for (const intent of intents) {
      const mark = (this.executor as any).getMark?.(intent.symbol);
      if (intent.action === 'buy') {
        if (bot.row.status === 'paused') continue; // paused = exits only
        const notional = intent.notionalUsd ?? 0;
        if (notional <= 0 || mark === undefined || mark <= 0) continue;
        if (notional > ctx.cashUsd) continue;
        void this.executor
          .placeOrder({
            botId: bot.row.id,
            symbol: intent.symbol,
            side: 'buy',
            type: intent.orderType ?? 'market',
            qty: notional / mark,
            limitPrice: intent.limitPrice,
            reason: intent.reason,
          })
          .catch((e) => console.error(`bot ${bot.row.id} buy failed:`, e.message));
      } else {
        const pos = ctx.positions.find((p) => p.symbol === intent.symbol);
        if (!pos) continue;
        const qty = intent.qty !== undefined ? Math.min(intent.qty, pos.qty) : pos.qty;
        if (qty <= 0) continue;
        void this.executor
          .placeOrder({
            botId: bot.row.id,
            symbol: intent.symbol,
            side: 'sell',
            type: intent.orderType ?? 'market',
            qty,
            limitPrice: intent.limitPrice,
            reason: intent.reason,
          })
          .catch((e) => console.error(`bot ${bot.row.id} sell failed:`, e.message));
      }
    }
  }

  private handleFill(fill: Fill): void {
    const bot = this.bots.get(fill.botId);
    const ownerUserId = bot?.row.kind === 'quant' ? bot.row.owner_user_id ?? undefined : undefined;
    const result = applyFill(this.db, fill, { quantOwnerUserId: ownerUserId ?? undefined });

    const trade: TradeView = {
      id: result.tradeId,
      botId: fill.botId,
      botName: bot?.row.name,
      symbol: fill.symbol,
      side: fill.side,
      qty: fill.qty,
      price: fill.price,
      feeUsd: fromMicro(fill.feeMicro),
      realizedPnlUsd: fromMicro(result.realizedPnlMicro),
      ts: fill.ts,
      reason: fill.reason,
    };
    this.emit('trade', trade);

    if (!result.taxPaid && bot) {
      // owner can't cover the $1 tax: pause (no new entries; exits still allowed)
      this.db.prepare(`UPDATE bots SET status = 'paused' WHERE id = ?`).run(fill.botId);
      bot.row.status = 'paused';
      this.emit('botPaused', { botId: fill.botId, reason: 'insufficient balance for trade tax' });
    }

    const eq = computeEquity(this.db, fill.botId, (s) => (this.executor as any).getMark?.(s));
    this.emit('botUpdate', { botId: fill.botId, equityUsd: fromMicro(eq.equityMicro) });
  }

  private snapshotAll(): void {
    for (const botId of this.bots.keys()) {
      try {
        snapshotMetrics(this.db, botId, (s) => (this.executor as any).getMark?.(s));
      } catch (e) {
        console.error(`snapshot bot ${botId}:`, e);
      }
    }
  }
}
