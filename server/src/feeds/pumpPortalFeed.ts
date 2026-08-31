import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { DB } from '../db/db.js';
import type { PumpTokenStats } from '../engine/strategies/strategy.js';

const WS_URL = 'wss://pumpportal.fun/api/data';
const TRACK_MAX_AGE_MS = 30 * 60_000;

interface TradeEvent {
  ts: number;
  isBuy: boolean;
  sol: number;
  trader: string;
}

/**
 * PumpPortal free data feed. Tracks tokens for their first 30 minutes with
 * rolling 60s buy/volume/unique-buyer stats. Emits:
 *   'launch' (PumpTokenStats), 'update' (PumpTokenStats), 'status'
 */
export class PumpPortalFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private tracked = new Map<string, { stats: PumpTokenStats; trades: TradeEvent[] }>();
  private evictTimer: NodeJS.Timeout | null = null;

  constructor(private db: DB) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.evictTimer = setInterval(() => this.evictOld(), 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.evictTimer) clearInterval(this.evictTimer);
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.emit('status', { connected: true, stale: false });
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      // resubscribe to tracked mints after reconnect
      const mints = [...this.tracked.keys()];
      if (mints.length) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.txType === 'create' && msg.mint) this.onLaunch(msg);
        else if ((msg.txType === 'buy' || msg.txType === 'sell') && msg.mint) this.onTrade(msg);
      } catch {
        // ignore
      }
    });

    const retry = () => {
      this.emit('status', { connected: false, stale: true });
      if (this.stopped) return;
      const base = Math.min(60_000, 1000 * 2 ** this.reconnectAttempt++);
      setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
    };
    ws.on('close', retry);
    ws.on('error', () => ws.terminate());
  }

  private onLaunch(msg: any) {
    const now = Date.now();
    const stats: PumpTokenStats = {
      mint: msg.mint,
      name: msg.name ?? null,
      symbol: msg.symbol ?? null,
      launchedAt: now,
      lastPriceSol: this.priceOf(msg),
      buys60s: 0,
      vol60s: 0,
      uniqueBuyers60s: 0,
    };
    this.tracked.set(msg.mint, { stats, trades: [] });
    this.persist(stats);
    this.ws?.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
    this.emit('launch', stats);
  }

  private onTrade(msg: any) {
    const entry = this.tracked.get(msg.mint);
    if (!entry) return;
    const now = Date.now();
    entry.trades.push({
      ts: now,
      isBuy: msg.txType === 'buy',
      sol: Number(msg.solAmount ?? 0),
      trader: String(msg.traderPublicKey ?? ''),
    });
    // keep only the rolling window
    const cutoff = now - 60_000;
    while (entry.trades.length && entry.trades[0].ts < cutoff) entry.trades.shift();

    const buys = entry.trades.filter((t) => t.isBuy);
    entry.stats.lastPriceSol = this.priceOf(msg) || entry.stats.lastPriceSol;
    entry.stats.buys60s = buys.length;
    entry.stats.vol60s = entry.trades.reduce((s, t) => s + t.sol, 0);
    entry.stats.uniqueBuyers60s = new Set(buys.map((t) => t.trader)).size;
    this.persist(entry.stats);
    this.emit('update', { ...entry.stats });
  }

  /** price per token in SOL from bonding-curve reserves when present */
  private priceOf(msg: any): number {
    const vSol = Number(msg.vSolInBondingCurve ?? 0);
    const vTok = Number(msg.vTokensInBondingCurve ?? 0);
    if (vSol > 0 && vTok > 0) return vSol / vTok;
    return 0;
  }

  private persist(s: PumpTokenStats) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pump_tokens
           (mint, name, symbol, launched_at, last_price_sol, mcap_sol, buys_60s, vol_60s, unique_buyers_60s, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.mint, s.name, s.symbol, s.launchedAt, s.lastPriceSol, 0, s.buys60s, s.vol60s, s.uniqueBuyers60s, Date.now());
  }

  private evictOld() {
    const cutoff = Date.now() - TRACK_MAX_AGE_MS;
    for (const [mint, entry] of this.tracked) {
      if (entry.stats.launchedAt < cutoff) {
        this.tracked.delete(mint);
        this.ws?.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
      }
    }
  }
}
