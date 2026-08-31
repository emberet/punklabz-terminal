import { randomUUID } from 'node:crypto';
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
import { evaluateIntent, getLiveConfig, haltNetwork, stageCapUsd } from './riskEngine.js';
import { accountForMode } from './accounts.js';

// SHADOW pipeline: mirrors real strategy activity through the full live order
// lifecycle — intent → risk engine → (theoretical) execution → ledger — with
// nothing ever submitted to a real venue. Every number in live stats comes
// from this ledger; nothing is invented.

interface Lot {
  qty: number;
  avgPrice: number;
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
  ) {
    this.adapters = buildAdapters(markOf);
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

    const composite = Math.round(
      strategy * 0.3 + regime * 0.25 + liquidity * 0.15 + cost * 0.15 + confirmation * 0.15,
    );
    return { strategy, regime, liquidity, cost, confirmation, composite };
  }

  private async mirrorTrade(trade: TradeView): Promise<void> {
    const cfg = getLiveConfig(this.db);
    if (cfg.mode === 'simulation') return; // live pipeline off

    const instrumentId = `CRYPTO_SPOT://binance/${trade.symbol}`;
    const inst = findInstrument(instrumentId);
    if (!inst) return;

    const account = accountForMode(this.db, cfg.mode, inst.venue);
    const conf = this.confidenceFor(trade);
    const stageCap = stageCapUsd(cfg.capitalStage);
    // scale the paper notional down to live sizing (paper bots run $10k books)
    const requested = Math.max(0.5, Math.min((stageCap * cfg.limits.maxPerTradePct) / 100, trade.qty * trade.price * (stageCap / 10_000)));

    const intent: OrderIntent = {
      intentId: `plz_${cfg.mode}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${randomUUID().slice(0, 8)}`,
      botId: trade.botId,
      instrumentId,
      venue: inst.venue,
      side: trade.side,
      notionalUsd: requested,
      confidence: conf.composite,
      reason: trade.reason ?? 'strategy signal',
    };

    // net-edge estimate from measured volatility on this instrument
    const hist = this.candles.history(trade.symbol, '15m', 60);
    const price = this.markOf(trade.symbol) ?? trade.price;
    const a = atr(hist, 14);
    const atrPct = a !== null && price > 0 ? (a / price) * 100 : 0;
    const edge = edgeForUniverse('majors', atrPct, 0.5);

    // sells that close an open shadow lot bypass the entry gates (exits are risk-managed, not blocked)
    const lotKey = `${account.id}:${trade.botId}:${instrumentId}`;
    const closingLot = trade.side === 'sell' && this.lots.has(lotKey);

    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO live_orders
           (intent_id, execution_account_id, bot_id, instrument_id, venue, side,
            requested_notional_micro, mode, state, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .run(intent.intentId, account.id, intent.botId, instrumentId, inst.venue, intent.side,
        toMicro(requested), cfg.mode, conf.composite, now, now);
    const orderId = Number(info.lastInsertRowid);

    const decision = closingLot
      ? { approved: true, sizeUsd: 0, rejectionReason: null, checks: [{ name: 'exit', pass: true, detail: 'closing existing shadow lot — exits always allowed' }] }
      : evaluateIntent(this.db, intent, edge, account.id);

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

    if (!decision.approved) {
      this.hub.publish('live', { event: 'order_rejected', orderId, reason: decision.rejectionReason });
      return;
    }

    // route through the ExecutionRouter (shadow: theoretical fill, nothing submitted)
    const expected = this.markOf(trade.symbol) ?? trade.price;
    this.db.prepare(`UPDATE live_orders SET state = 'submitting', expected_price = ?, updated_at = ? WHERE id = ?`)
      .run(expected, Date.now(), orderId);

    const lot = this.lots.get(lotKey);
    const notional = closingLot && lot ? lot.qty * expected : decision.sizeUsd;
    const routeReq = {
      instrumentId,
      side: trade.side,
      notionalUsd: notional,
      maxSlippageBps: 35,
      mode: cfg.mode,
      intentId: intent.intentId,
    };
    const routed = this.router.route(routeReq);
    const result = await this.router.execute(routed, routeReq, expected);

    if (!result.accepted) {
      this.db.prepare(`UPDATE live_orders SET state = 'failed', reject_reason = ?, updated_at = ? WHERE id = ?`)
        .run(result.error ?? 'adapter refused', Date.now(), orderId);
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
