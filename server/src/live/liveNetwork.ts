import { createHash } from 'node:crypto';
import type { CompositeConfidence, OrderIntent, TradeView } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { WsHub } from '../realtime/wsHub.js';
import { toMicro, fromMicro } from '../money.js';
import { classifyRegime, REGIME_AFFINITY } from '../analysis/regime.js';
import { atr } from '../engine/indicators.js';
import type { CandleStore } from '../feeds/candles.js';
import { buildAdapters, type ExecutionAdapter } from './adapters.js';
import { ExecutionRouter } from './executionRouter.js';
import { edgeForUniverse } from './edge.js';
import { findInstrument } from './instruments.js';
import { resolveLiveInstrument } from './instrumentResolver.js';
import { evaluateIntent, getLiveConfig, haltNetwork, stageCapUsd } from './riskEngine.js';
import { accountForMode } from './accounts.js';
import type { TradingSigner } from './signing/signer.js';
import { currentWeights } from '../research/scoring.js';
import { openEdgeClaim } from '../research/predictions.js';
import { appendAudit } from '../audit/auditLog.js';
import { runTradeHuddle } from '../research/discussion.js';

// SHADOW pipeline: mirrors real strategy activity through the full live order
// lifecycle — intent → risk engine → (theoretical) execution → ledger — with
// nothing ever submitted to a real venue. Every number in live stats comes
// from this ledger; nothing is invented.

interface Lot {
  qty: number;
  avgPrice: number;
}

interface OperatorTradeContext {
  experimentRunId?: number;
  exactSellQuantity?: number;
}

export class LiveNetwork {
  private adapters: Map<string, ExecutionAdapter>;
  private router: ExecutionRouter;
  /** `${accountId}:${botId}:${instrumentId}` — books never mix across accounts */
  private lots = new Map<string, Lot>();

  constructor(
    private db: DB,
    private hub: WsHub,
    private candles: CandleStore,
    private markOf: (s: string) => number | undefined,
    signer?: TradingSigner,
    adapters?: Map<string, ExecutionAdapter>,
  ) {
    this.adapters = adapters ?? buildAdapters(markOf, signer, db);
    this.router = new ExecutionRouter(this.adapters);
    this.restoreLots();
  }

  attach(engine: Engine): void {
    engine.on('trade', (trade: TradeView) => {
      // only mirror majors (real, liquid marks); pump tokens stay paper-only
      if (!trade.symbol.endsWith('USDT')) return;
      void this.mirrorTrade(trade).catch((e) => console.error('shadow mirror failed:', e));
    });
  }

  /** deterministic composite confidence from real, named components — SYSTEM CONFIDENCE, not win probability */
  private confidenceFor(trade: TradeView): CompositeConfidence {
    const bot = this.db
      .prepare(
        `SELECT b.strategy_type,
                (SELECT COUNT(*) FROM trades t WHERE t.bot_id = b.id AND t.side='sell') AS sells,
                (SELECT COUNT(*) FROM trades t WHERE t.bot_id = b.id AND t.side='sell' AND t.realized_pnl_micro > 0) AS wins
         FROM bots b WHERE b.id = ?`,
      )
      .get(trade.botId) as { strategy_type: string; sells: number; wins: number } | undefined;

    // strategy: realized win rate with low-sample shrink toward 50
    const sells = bot?.sells ?? 0;
    const rawWr = sells > 0 ? (bot!.wins / sells) * 100 : 50;
    const strategy = Math.round((rawWr * sells + 50 * 10) / (sells + 10));

    // regime fit: does this machine class match the current regime?
    const reading = classifyRegime(this.candles.history(trade.symbol, '1m', 360));
    const fits = reading ? REGIME_AFFINITY[reading.regime]?.includes(bot?.strategy_type ?? '') : false;
    const regime = reading ? (fits ? 90 : 55) : 50;

    // liquidity: majors on live feeds are deep
    const liquidity = 95;
    // cost: modeled 20bps round-trip vs the strategy's typical stop distance
    const cost = 75;
    // confirmation: the strategy stated a concrete reason
    const confirmation = trade.reason && trade.reason.length > 4 ? 85 : 55;

    // Weights come from resolved predictions, not from anything an agent said.
    // With no resolved predictions they equal the constants this line used to
    // hardcode (0.3 / 0.25 / 0.15 / 0.15 / 0.15), so a freshly migrated network
    // scores exactly as it did before the research loop existed.
    const w = currentWeights(this.db);
    const composite = Math.round(
      strategy * w.strategy + regime * w.regime + liquidity * w.liquidity +
      cost * w.cost + confirmation * w.confirmation,
    );
    return { strategy, regime, liquidity, cost, confirmation, composite };
  }

  /**
   * A signal we cannot route is recorded, not discarded. An unmapped symbol
   * silently doing nothing looks identical to a quiet market, and the whole
   * point of the resolver is that the refusal is visible and explains itself.
   */
  private recordUnroutable(
    trade: TradeView,
    mode: string,
    reason: string,
    forcedBy?: string,
    context: OperatorTradeContext = {},
  ): void {
    const account = accountForMode(this.db, mode as never);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO live_orders
           (intent_id, execution_account_id, bot_id, instrument_id, venue, side,
            requested_notional_micro, mode, state, reject_reason, forced_by, operator_test,
            experiment_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'unresolved', ?, 0, ?, 'risk_rejected', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `plz_unmapped_${trade.botId}_${trade.symbol}_${now}`,
        account.id, trade.botId, trade.symbol, trade.side, mode,
        `no live instrument mapping: ${reason}`.slice(0, 300), forcedBy ?? null,
        forcedBy ? 1 : 0, context.experimentRunId ?? null, now, now,
      );
    this.hub.publish('live', { event: 'order_rejected', symbol: trade.symbol, reason });
  }

  /**
   * OPERATOR-FORCED TRADE.
   *
   * Runs the REAL path — same resolver, same risk engine, same router, same
   * adapter, same ledger writes — with a synthetic signal instead of a
   * strategy's. It exists because the execution path cannot be proven while no
   * strategy has fired, and an untested payment path is not a safe one.
   *
   * It is deliberately thin: it builds a TradeView and hands it to
   * mirrorTrade. Anything that duplicated mirrorTrade's bookkeeping would
   * drift from it, and then the thing being tested would not be the thing that
   * runs in production.
   */
  async forceTrade(params: {
    botId: number;
    symbol: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
    actor: string;
    idempotencyKey: string;
    experimentRunId?: number;
    exactSellQuantity?: number;
  }): Promise<{ orderId: number | null; state: string; detail: string }> {
    const cfg = getLiveConfig(this.db);
    if (cfg.halted) {
      return { orderId: null, state: 'refused', detail: `network halted: ${cfg.haltReason}` };
    }
    const price = this.markOf(params.symbol);
    if (!price || price <= 0) {
      // No mark means no way to size the order or measure slippage against it.
      return { orderId: null, state: 'refused', detail: `no live mark for ${params.symbol}` };
    }
    const bot = this.db.prepare(`SELECT id, name, status FROM bots WHERE id=?`).get(params.botId) as
      { id: number; name: string; status: string } | undefined;
    if (!bot || bot.status === 'stopped') {
      return { orderId: null, state: 'refused', detail: `sponsor bot ${params.botId} is not active` };
    }
    if (params.side !== 'sell' && params.exactSellQuantity !== undefined) {
      return { orderId: null, state: 'refused', detail: 'exact quantity is only valid for a sell' };
    }

    appendAudit(this.db, params.actor, 'live_force_trade', {
      botId: params.botId, symbol: params.symbol, side: params.side,
      notionalUsd: params.notionalUsd, mode: cfg.mode, experimentRunId: params.experimentRunId,
    });

    const account = accountForMode(this.db, cfg.mode, 'evm:robinhood');
    const sourceId = `operator:${params.idempotencyKey}`;
    const synthetic: TradeView = {
      id: 0,
      botId: params.botId,
      symbol: params.symbol,
      side: params.side,
      qty: params.exactSellQuantity ?? params.notionalUsd / price,
      price,
      feeUsd: 0,
      realizedPnlUsd: 0,
      ts: Date.now(),
      reason: `operator test sponsored by ${bot.name}; forced by ${params.actor}`,
    };
    await this.mirrorTrade(
      synthetic,
      params.actor,
      sourceId,
      { experimentRunId: params.experimentRunId, exactSellQuantity: params.exactSellQuantity },
    );

    const intentId = this.intentId(cfg.mode, account.id, synthetic, sourceId);
    const row = this.db
      .prepare(`SELECT id, state, reject_reason, tx_ref FROM live_orders WHERE intent_id = ?`)
      .get(intentId) as { id: number; state: string; reject_reason: string | null; tx_ref: string | null } | undefined;
    if (!row) return { orderId: null, state: 'no_order', detail: 'nothing was recorded — the signal never reached the risk engine' };
    return {
      orderId: row.id,
      state: row.state,
      detail: row.reject_reason ?? (row.tx_ref ? `tx ${row.tx_ref}` : 'submitted'),
    };
  }

  private intentId(mode: string, accountId: number, trade: TradeView, sourceId?: string): string {
    const digest = createHash('sha256')
      .update([mode, accountId, trade.botId, trade.symbol, trade.side, sourceId ?? trade.id].join(':'))
      .digest('hex').slice(0, 24);
    return `plz_${mode}_${digest}`;
  }

  /** Position truth comes from confirmed ledger fills, including fills posted by the supervisor. */
  private ledgerLot(accountId: number, botId: number, instrumentId: string): Lot | null {
    const fills = this.db.prepare(
      `SELECT side, qty, executed_price FROM live_ledger
       WHERE execution_account_id=? AND bot_id IS ? AND instrument_id=? ORDER BY id`,
    ).all(accountId, botId, instrumentId) as { side: string; qty: number; executed_price: number }[];
    let qty = 0;
    let cost = 0;
    for (const fill of fills) {
      if (fill.side === 'buy') {
        cost += fill.qty * fill.executed_price;
        qty += fill.qty;
      } else if (qty > 0) {
        const sold = Math.min(qty, fill.qty);
        cost -= sold * (cost / qty);
        qty -= sold;
      }
    }
    return qty > 1e-9 ? { qty, avgPrice: cost / qty } : null;
  }

  private async mirrorTrade(
    trade: TradeView,
    forcedBy?: string,
    sourceId?: string,
    context: OperatorTradeContext = {},
  ): Promise<void> {
    const cfg = getLiveConfig(this.db);
    if (cfg.mode === 'simulation') return; // live pipeline off

    // A strategy names a PAPER symbol. Executing that name directly is how a
    // signal about "ETHUSDT on Binance" becomes an order on whatever venue
    // happens to list something called ETH. The resolver is the only thing
    // permitted to turn a signal into a destination, and it names the chain,
    // both contract addresses and their decimals explicitly.
    //
    // Shadow keeps using the paper instrument, because shadow is precisely the
    // mode that books theoretical fills against paper market data. Anything
    // that can move funds must resolve.
    const realMoney = cfg.mode === 'canary' || cfg.mode === 'live';
    if (realMoney && Date.now() - trade.ts > 60_000) {
      this.recordUnroutable(trade, cfg.mode, 'signal is older than 60 seconds', forcedBy, context);
      return;
    }
    let inst;
    if (realMoney) {
      const resolution = resolveLiveInstrument(trade.symbol);
      if (!resolution.mapped || !resolution.instrument) {
        this.recordUnroutable(trade, cfg.mode, resolution.reason, forcedBy, context);
        return;
      }
      inst = resolution.instrument;
    } else {
      inst = findInstrument(`CRYPTO_SPOT://binance/${trade.symbol}`);
      if (!inst) return;
    }
    const instrumentId = inst.id;

    const account = accountForMode(this.db, cfg.mode, inst.venue);
    const conf = this.confidenceFor(trade);
    const stageCap = stageCapUsd(cfg.capitalStage);
    const lotKey = `${account.id}:${trade.botId}:${instrumentId}`;
    const lot = this.ledgerLot(account.id, trade.botId, instrumentId) ?? this.lots.get(lotKey);
    const closingLot = trade.side === 'sell' && !!lot;
    const exactFullExit = context.exactSellQuantity !== undefined;
    if (exactFullExit) {
      if (!context.experimentRunId || !closingLot || !lot) {
        this.recordUnroutable(trade, cfg.mode, 'exact sell requires a probe run and an open ledger lot', forcedBy, context);
        return;
      }
      const tolerance = Math.max(1e-12, lot.qty * 1e-9);
      if (Math.abs(context.exactSellQuantity! - lot.qty) > tolerance) {
        this.recordUnroutable(
          trade, cfg.mode,
          `exact sell quantity ${context.exactSellQuantity} does not match full ledger lot ${lot.qty}`,
          forcedBy, context,
        );
        return;
      }
    }
    // scale the paper notional down to live sizing (paper bots run $10k books)
    //
    // A forced trade is NOT scaled: the operator named a real dollar amount,
    // and passing it through the paper-book divisor would turn a deliberate $5
    // test into $0.03. It is still clamped by the per-trade cap below, which is
    // the gate that actually protects funds.
    const perTradeCap = (stageCap * cfg.limits.maxPerTradePct) / 100;
    const requested = context.exactSellQuantity !== undefined
      ? context.exactSellQuantity * (this.markOf(trade.symbol) ?? trade.price)
      : closingLot
      ? lot.qty * (this.markOf(trade.symbol) ?? trade.price)
      : forcedBy
      ? Math.max(0.5, Math.min(perTradeCap, trade.qty * trade.price))
      : Math.max(0.5, Math.min(perTradeCap, trade.qty * trade.price * (stageCap / 10_000)));

    const intent: OrderIntent = {
      intentId: this.intentId(cfg.mode, account.id, trade, sourceId),
      botId: trade.botId,
      instrumentId,
      venue: inst.venue,
      side: trade.side,
      notionalUsd: requested,
      confidence: conf.composite,
      reason: trade.reason ?? 'strategy signal',
      forcedBy,
    };

    // net-edge estimate from measured volatility on this instrument
    const hist = this.candles.history(trade.symbol, '15m', 60);
    const price = this.markOf(trade.symbol) ?? trade.price;
    const a = atr(hist, 14);
    const atrPct = a !== null && price > 0 ? (a / price) * 100 : 0;
    const edge = edgeForUniverse('majors', atrPct, 0.5);

    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO live_orders
           (intent_id, execution_account_id, bot_id, instrument_id, venue, side,
            requested_notional_micro, mode, state, confidence, capital_stage, forced_by,
            signal_ts, operator_test, experiment_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(intent.intentId, account.id, intent.botId, instrumentId, inst.venue, intent.side,
        toMicro(requested), cfg.mode, conf.composite, cfg.capitalStage, forcedBy ?? null, trade.ts,
        forcedBy ? 1 : 0, context.experimentRunId ?? null, now, now);
    if (info.changes === 0) return;
    const orderId = Number(info.lastInsertRowid);

    const decision = evaluateIntent(this.db, intent, edge, account.id, undefined, {
      isExit: closingLot,
      exactFullExit,
    });

    this.db
      .prepare(`UPDATE live_orders SET state = ?, approved_notional_micro = ?, risk_json = ?, reject_reason = ?, updated_at = ? WHERE id = ?`)
      .run(
        decision.approved ? 'risk_approved' : 'risk_rejected',
        toMicro(decision.sizeUsd),
        JSON.stringify({ checks: decision.checks, confidence: conf, edge }),
        decision.rejectionReason,
        Date.now(),
        orderId,
      );

    if (trade.symbol === 'ETHUSDT') {
      const measuredInputs = {
        intentId: intent.intentId,
        orderId,
        symbol: trade.symbol,
        side: trade.side,
        requestedNotionalUsd: requested,
        approved: decision.approved,
        approvedNotionalUsd: decision.sizeUsd,
        confidence: conf,
        edge,
        riskChecks: decision.checks,
        advisory: true,
      };
      void runTradeHuddle(
        this.db, this.hub, this.candles, this.markOf,
        { orderId, signalId: intent.intentId, botId: trade.botId, symbol: trade.symbol, side: trade.side, measuredInputs },
      ).then((session) => {
        if (session.sessionId) {
          this.db.prepare(`UPDATE live_orders SET discussion_session_id=? WHERE id=?`)
            .run(session.sessionId, orderId);
        }
      }).catch((error) => console.error('trade huddle failed:', String(error).slice(0, 120)));
    }

    if (!decision.approved) {
      this.hub.publish('live', { event: 'order_rejected', orderId, reason: decision.rejectionReason });
      return;
    }

    // Every approved intent stakes a falsifiable claim: the edge we priced this
    // on will actually show up. Resolved later by arithmetic, and it is what
    // moves the confidence weights — including when we are wrong.
    openEdgeClaim(
      this.db, `bot:${trade.botId}`, trade.symbol, this.markOf(trade.symbol) ?? trade.price,
      edge.netEdgeBps, conf.composite / 100, forcedBy ? null : trade.botId,
    );

    // route through the ExecutionRouter (shadow: theoretical fill, nothing submitted)
    const expected = this.markOf(trade.symbol) ?? trade.price;
    this.db.prepare(`UPDATE live_orders SET state = 'submitting', expected_price = ?, updated_at = ? WHERE id = ?`)
      .run(expected, Date.now(), orderId);

    // Route exactly the amount the risk engine approved. The only exception is
    // a caller-verified, receipt-derived full-lot probe close; its approved
    // notional was computed from this same exact quantity above.
    const notional = decision.sizeUsd;
    const routeReq = {
      instrumentId,
      side: trade.side,
      notionalUsd: notional,
      maxSlippageBps: cfg.limits.maxSlippageBps ?? 35,
      mode: cfg.mode,
      intentId: intent.intentId,
      orderId,
      accountId: account.id,
      grossEdgeBps: forcedBy ? undefined : edge.grossEdgeBps,
      safetyBufferBps: Math.max(10, edge.bufferBps),
      operatorTest: context.experimentRunId !== undefined && context.experimentRunId !== null,
      exactSellQuantity: context.exactSellQuantity,
    };
    const routed = this.router.route(routeReq);
    const result = await this.router.execute(routed, routeReq, expected);

    if (!result.accepted) {
      this.db.prepare(`UPDATE live_orders SET state = 'failed', reject_reason = ?, updated_at = ? WHERE id = ?`)
        .run(result.error ?? 'adapter refused', Date.now(), orderId);
      const transaction = this.db.prepare(
        `SELECT id, state FROM execution_transactions WHERE order_id=? ORDER BY id DESC LIMIT 1`,
      ).get(orderId) as { id: number; state: string } | undefined;
      if (realMoney && transaction && transaction.state !== 'confirmed') {
        haltNetwork(this.db,
          `order ${orderId} has ${transaction.state} transaction ${transaction.id}: ${result.error ?? 'adapter failure'}`,
          'live-network');
      }
      this.hub.publish('live', { event: 'order_failed', orderId, reason: result.error });
      return;
    }
    // accepted but unresolved: the venue has it, we don't know the outcome yet.
    // Never book a fill we haven't seen — the reconciler resolves these.
    if (result.pending || result.executedPrice === undefined) {
      this.db
        .prepare(
          `UPDATE live_orders SET state = 'pending', venue_order_id = ?, tx_ref = ?, min_receive = ?,
           submitted_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(result.venueOrderId ?? null, result.txRef ?? null, result.minReceive ?? null,
          Date.now(), Date.now(), orderId);
      this.hub.publish('live', { event: 'order_pending', orderId, venueOrderId: result.venueOrderId });
      return;
    }

    const qty = notional / result.executedPrice;
    const slippageBps = result.slippageBps;

    // realized pnl on closes, avg-cost
    let realizedMicro = 0;
    if (trade.side === 'buy') {
      const cur = this.lots.get(lotKey);
      if (cur) {
        const nq = cur.qty + qty;
        cur.avgPrice = (cur.avgPrice * cur.qty + result.executedPrice * qty) / nq;
        cur.qty = nq;
      } else this.lots.set(lotKey, { qty, avgPrice: result.executedPrice });
    } else if (lot) {
      const sellQty = Math.min(qty, lot.qty);
      realizedMicro = toMicro(sellQty * (result.executedPrice - lot.avgPrice));
      lot.qty -= sellQty;
      if (lot.qty <= 1e-9) this.lots.delete(lotKey);
    }

    const ts = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE live_orders SET state = 'filled', executed_price = ?, slippage_bps = ?, fee_micro = ?,
           tx_ref = ?, venue_order_id = ?, min_receive = ?, filled_qty = ?, updated_at = ? WHERE id = ?`,
        )
        .run(result.executedPrice, slippageBps, toMicro(result.feeUsd ?? 0), result.txRef ?? null,
          result.venueOrderId ?? null, result.minReceive ?? null, qty, ts, orderId);
      this.db
        .prepare(
          `INSERT INTO live_ledger (order_id, execution_account_id, bot_id, instrument_id, venue, side, qty,
             expected_price, executed_price, fee_micro, gas_micro, slippage_bps, realized_pnl_micro, mode, tx_ref, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(orderId, account.id, trade.botId, instrumentId, routed.venue, trade.side, qty, expected, result.executedPrice,
          toMicro(result.feeUsd ?? 0), slippageBps, realizedMicro, cfg.mode, result.txRef ?? null, ts);
    })();

    this.hub.publish('live', {
      event: 'order_filled',
      orderId,
      side: trade.side,
      instrumentId,
      executedPrice: result.executedPrice,
      slippageBps,
      realizedPnlUsd: fromMicro(realizedMicro),
      mode: cfg.mode,
    });
  }

  private restoreLots(): void {
    // Account-scoped. Previously this summed the whole ledger with no filter,
    // which would have let a shadow book seed a live account's positions.
    const rows = this.db
      .prepare(
        `SELECT execution_account_id, bot_id, instrument_id, side, qty, executed_price
         FROM live_ledger ORDER BY ts ASC`,
      )
      .all() as {
        execution_account_id: number; bot_id: number; instrument_id: string;
        side: string; qty: number; executed_price: number;
      }[];
    for (const r of rows) {
      const key = `${r.execution_account_id}:${r.bot_id}:${r.instrument_id}`;
      const lot = this.lots.get(key);
      if (r.side === 'buy') {
        if (lot) {
          const nq = lot.qty + r.qty;
          lot.avgPrice = (lot.avgPrice * lot.qty + r.executed_price * r.qty) / nq;
          lot.qty = nq;
        } else this.lots.set(key, { qty: r.qty, avgPrice: r.executed_price });
      } else if (lot) {
        lot.qty -= Math.min(lot.qty, r.qty);
        if (lot.qty <= 1e-9) this.lots.delete(key);
      }
    }
  }

  /** SENTINEL: health + reconciliation loop; can trip the circuit breaker. */
  startSentinel(feedStatus: Record<string, { connected: boolean; stale: boolean }>): void {
    setInterval(async () => {
      try {
        for (const [venue, adapter] of this.adapters) {
          if (venue === 'paper') continue;
          const h = await adapter.health();
          this.db
            .prepare(
              `INSERT INTO venue_health (venue, status, latency_ms, error_rate, last_ok_at, note, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(venue) DO UPDATE SET status=excluded.status, latency_ms=excluded.latency_ms,
                 error_rate=excluded.error_rate, last_ok_at=excluded.last_ok_at, note=excluded.note, updated_at=excluded.updated_at`,
            )
            .run(h.venue, h.status, h.latencyMs, h.errorRate, h.lastOkAt, h.note, Date.now());
        }
        // circuit breaker: market data failure while above simulation
        const cfg = getLiveConfig(this.db);
        if (cfg.mode !== 'simulation' && !cfg.halted) {
          const down = Object.values(feedStatus).some((f) => !f.connected);
          if (down) haltNetwork(this.db, 'automatic circuit breaker: market data feed down', 'sentinel');
        }
      } catch (e) {
        console.error('sentinel pass failed:', e);
      }
    }, 15_000);
  }

  venues(): Promise<{ venue: string; health: Promise<unknown> }[]> {
    return Promise.resolve([...this.adapters.keys()].map((venue) => ({ venue, health: this.adapters.get(venue)!.health() })));
  }
}
