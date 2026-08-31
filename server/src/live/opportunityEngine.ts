import type { Interval } from '@punklabz/shared';
import { MAJOR_SYMBOLS } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import type { CandleStore } from '../feeds/candles.js';
import type { MemeFeed } from '../feeds/memeFeed.js';
import type { WsHub } from '../realtime/wsHub.js';
import { atr, bollinger, ema, rsi, sma } from '../engine/indicators.js';
import { classifyRegime } from '../analysis/regime.js';
import { edgeForUniverse, type EdgeBreakdown, type Universe } from './edge.js';
import { INTERVAL_MS } from '@punklabz/shared';

// THE BUSY PART. Scanners observe every market the network has real data for
// and produce candidates → signals → high-confidence opportunities. Almost
// everything is rejected, mostly on net edge, and that is the point:
//
//   DO NOT TRADE MORE. FIND BETTER TRADES.
//
// Every number here comes from measured market data. Scanner opportunities are
// ADVISORY — they never commit capital on their own; they are the network
// thinking out loud. Only a machine's own committed trade reaches execution.

export interface Opportunity {
  scanner: string;
  universe: Universe;
  instrumentId: string;
  symbol: string;
  direction: 'buy' | 'sell';
  confidence: number;
  edge: EdgeBreakdown;
  evidence: Record<string, number | string>;
}

export interface ScanCounts {
  marketsObserved: number;
  scansPerformed: number;
  candidates: number;
  signals: number;
  highConfidence: number;
}

const SCAN_INTERVALS: Interval[] = ['5m', '15m', '1h'];
const HIGH_CONFIDENCE = 80;

export class OpportunityEngine {
  private lastCounts: ScanCounts = {
    marketsObserved: 0, scansPerformed: 0, candidates: 0, signals: 0, highConfidence: 0,
  };
  private timer: NodeJS.Timeout | null = null;
  /** an idea already emitted must not repeat on every 20s pass: candle
   *  universes key on the closed bar, streaming universes on a 5-minute bucket */
  private seen = new Set<string>();

  private fresh(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-2000));
    return true;
  }

  constructor(
    private db: DB,
    private candles: CandleStore,
    private memeFeed: MemeFeed,
    private hub: WsHub,
  ) {}

  start(intervalMs = 20_000): void {
    this.timer = setInterval(() => {
      try {
        this.runPass();
      } catch (e) {
        console.error('scan pass failed:', e);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  counts(): ScanCounts {
    return this.lastCounts;
  }

  runPass(): ScanCounts {
    const t0 = Date.now();
    const counts: ScanCounts = {
      marketsObserved: 0, scansPerformed: 0, candidates: 0, signals: 0, highConfidence: 0,
    };
    const found: Opportunity[] = [];

    for (const opp of this.scanMajors(counts)) found.push(opp);
    for (const opp of this.scanPumpFun(counts)) found.push(opp);
    for (const opp of this.scanMultichain(counts)) found.push(opp);

    counts.signals = found.length;
    counts.highConfidence = found.filter((o) => o.confidence >= HIGH_CONFIDENCE).length;

    const ts = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scan_passes (ts, duration_ms, markets_observed, scans_performed, candidates, signals, high_confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ts, ts - t0, counts.marketsObserved, counts.scansPerformed, counts.candidates, counts.signals, counts.highConfidence);

      const stmt = this.db.prepare(
        `INSERT INTO opportunities
           (ts, scanner, universe, instrument_id, symbol, direction, confidence,
            gross_edge_bps, fee_bps, slippage_bps, buffer_bps, net_edge_bps, edge_model,
            evidence_json, state, reject_reason, advisory)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      for (const o of found) {
        const high = o.confidence >= HIGH_CONFIDENCE;
        // the net-edge gate: this is where most ideas die
        const rejected = !o.edge.viable;
        const state = rejected ? 'rejected' : high ? 'high_confidence' : 'signal';
        stmt.run(
          ts, o.scanner, o.universe, o.instrumentId, o.symbol, o.direction, o.confidence,
          o.edge.grossEdgeBps, o.edge.feeBps, o.edge.slippageBps, o.edge.bufferBps,
          o.edge.netEdgeBps, o.edge.edgeModel, JSON.stringify(o.evidence), state,
          rejected ? `net edge ${(o.edge.netEdgeBps / 100).toFixed(2)}% after costs` : null,
        );
      }
      // keep the table bounded — this runs every 20s forever
      this.db.prepare(`DELETE FROM opportunities WHERE ts < ?`).run(ts - 24 * 3_600_000);
      this.db.prepare(`DELETE FROM scan_passes WHERE ts < ?`).run(ts - 7 * 86_400_000);
    })();

    this.lastCounts = counts;
    this.hub.publishThrottled('process', { counts, ts }, 2000);
    return counts;
  }

  // ── universe 1: majors, real candles and indicators ──
  private *scanMajors(counts: ScanCounts): Generator<Opportunity> {
    for (const symbol of MAJOR_SYMBOLS) {
      counts.marketsObserved++;
      const reading = classifyRegime(this.candles.history(symbol, '1m', 360));

      for (const interval of SCAN_INTERVALS) {
        const raw = this.candles.history(symbol, interval, 120);
        counts.scansPerformed++;
        // drop a still-forming final bar: its volume is partial and would make
        // every volume comparison meaningless
        const now = Date.now();
        const hist = raw.length && raw[raw.length - 1].ts + INTERVAL_MS[interval] > now ? raw.slice(0, -1) : raw;
        if (hist.length < 30) continue;
        counts.candidates++;

        const barTs = hist[hist.length - 1].ts;
        const fresh = (scanner: string) => this.fresh(`${scanner}|${symbol}|${interval}|${barTs}`);

        const closes = hist.map((c) => c.c);
        const vols = hist.map((c) => c.v);
        const price = closes[closes.length - 1];
        const a = atr(hist, 14);
        if (a === null || price <= 0) continue;
        const atrPct = (a / price) * 100;

        const e9 = ema(closes, 9);
        const e21 = ema(closes, 21);
        const r = rsi(closes, 14);
        const bb = bollinger(closes, 20, 2);
        // Single-bar volume spikes are noise-prone — one bar is close to a coin
        // flip. Confirm over a window: 3-bar average against the 20-bar baseline.
        const volBaseline = sma(vols.slice(0, -3), 20);
        const volRecent = sma(vols.slice(-3), 3);
        const volRatio = volBaseline && volBaseline > 0 && volRecent ? volRecent / volBaseline : 1;
        // Volatility expansion measured against this instrument's OWN recent
        // width, so the threshold means the same thing on BTC as on a memecoin.
        const widthNow = bb?.width ?? 0;
        const priorWidths: number[] = [];
        for (let k = 6; k >= 1; k--) {
          const w = bollinger(closes.slice(0, closes.length - k), 20, 2)?.width;
          if (w !== undefined) priorWidths.push(w);
        }
        const widthBase = priorWidths.length ? priorWidths.reduce((s, w) => s + w, 0) / priorWidths.length : 0;
        const widthExpansion = widthBase > 0 ? widthNow / widthBase : 1;
        const instrumentId = `CRYPTO_SPOT://binance/${symbol}`;

        // momentum scanner
        if (e9 !== null && e21 !== null && e9 > e21 && price > e9 && volRatio > 1.15 && fresh('momentum')) {
          const trendFit = reading?.regime === 'TRENDING UP' || reading?.regime === 'BREAKOUT';
          yield {
            scanner: 'momentum',
            universe: 'majors',
            instrumentId,
            symbol,
            direction: 'buy',
            confidence: Math.round(60 + (trendFit ? 22 : 0) + Math.min(12, (volRatio - 1.15) * 25)),
            edge: edgeForUniverse('majors', atrPct, 0.5),
            evidence: {
              interval, ema9: +e9.toFixed(2), ema21: +e21.toFixed(2),
              volumeRatio: +volRatio.toFixed(2), atrPct: +atrPct.toFixed(3),
              regime: reading?.regime ?? 'unknown',
            },
          };
        }

        // mean-reversion scanner
        if (r !== null && bb !== null && r < 32 && price < bb.lower && fresh('mean_reversion')) {
          const fit = reading?.regime === 'RANGING';
          yield {
            scanner: 'mean_reversion',
            universe: 'majors',
            instrumentId,
            symbol,
            direction: 'buy',
            confidence: Math.round(58 + (fit ? 24 : 0) + Math.min(14, (32 - r))),
            edge: edgeForUniverse('majors', atrPct, 0.6),
            evidence: {
              interval, rsi: +r.toFixed(1), bollingerLower: +bb.lower.toFixed(2),
              price: +price.toFixed(2), atrPct: +atrPct.toFixed(3),
              regime: reading?.regime ?? 'unknown',
            },
          };
        }

        // volatility-expansion scanner
        if (bb !== null && widthExpansion > 1.35 && fresh('volatility')) {
          yield {
            scanner: 'volatility',
            universe: 'majors',
            instrumentId,
            symbol,
            direction: closes[closes.length - 1] > closes[closes.length - 5] ? 'buy' : 'sell',
            confidence: Math.round(52 + Math.min(24, (widthExpansion - 1.35) * 40)),
            edge: edgeForUniverse('majors', atrPct, 0.7),
            evidence: {
              interval, bollingerWidth: +bb.width.toFixed(4),
              widthExpansion: +widthExpansion.toFixed(2),
              volumeRatio: +volRatio.toFixed(2), atrPct: +atrPct.toFixed(3),
            },
          };
        }
      }
    }
  }

  // ── universe 2: pump.fun launches, real rolling 60s stats ──
  private *scanPumpFun(counts: ScanCounts): Generator<Opportunity> {
    const rows = this.db
      .prepare(
        `SELECT mint, symbol, name, launched_at, last_price_sol, buys_60s, vol_60s, unique_buyers_60s
         FROM pump_tokens WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 800`,
      )
      .all(Date.now() - 30 * 60_000) as any[];

    for (const t of rows) {
      counts.marketsObserved++;
      counts.scansPerformed++;
      if (t.last_price_sol <= 0) continue;
      counts.candidates++;
      const ageMin = (Date.now() - t.launched_at) / 60_000;
      const bucket = Math.floor(Date.now() / 300_000);
      const instrumentId = `CRYPTO_SPOT://pumpfun/${t.mint}`;

      // launch scanner: fresh + real buyer breadth
      if (ageMin < 5 && t.unique_buyers_60s >= 8 && this.fresh(`launch|${t.mint}|${bucket}`)) {
        yield {
          scanner: 'launch',
          universe: 'pumpfun',
          instrumentId,
          symbol: t.symbol ?? t.mint.slice(0, 6),
          direction: 'buy',
          confidence: Math.round(50 + Math.min(30, t.unique_buyers_60s * 2)),
          // pump launches are violently volatile — high assumed excursion, but
          // costs are brutal, so the net-edge gate still kills most of them
          edge: edgeForUniverse('pumpfun', 12, 0.5),
          evidence: {
            ageMinutes: +ageMin.toFixed(1), uniqueBuyers60s: t.unique_buyers_60s,
            buys60s: t.buys_60s, volSol60s: +t.vol_60s.toFixed(2),
          },
        };
      }

      // herd scanner: sustained pressure on a surviving token
      if (ageMin >= 2 && ageMin <= 20 && t.buys_60s >= 20 && this.fresh(`herd|${t.mint}|${bucket}`)) {
        yield {
          scanner: 'herd',
          universe: 'pumpfun',
          instrumentId,
          symbol: t.symbol ?? t.mint.slice(0, 6),
          direction: 'buy',
          confidence: Math.round(48 + Math.min(28, t.buys_60s)),
          edge: edgeForUniverse('pumpfun', 9, 0.5),
          evidence: {
            ageMinutes: +ageMin.toFixed(1), buys60s: t.buys_60s,
            uniqueBuyers60s: t.unique_buyers_60s, volSol60s: +t.vol_60s.toFixed(2),
          },
        };
      }
    }
  }

  // ── universe 3: cross-chain trending tokens, real change data ──
  private *scanMultichain(counts: ScanCounts): Generator<Opportunity> {
    for (const t of this.memeFeed.snapshot()) {
      counts.marketsObserved++;
      counts.scansPerformed++;
      if (t.change5m === null || t.change1h === null || t.priceUsd === null) continue;
      counts.candidates++;

      // short-term acceleration against the hour: real measured divergence
      const bucket = Math.floor(Date.now() / 300_000);
      if (t.change5m > 3 && t.change1h > 0 && (t.volume24hUsd ?? 0) > 50_000 && this.fresh(`ccm|${t.id}|${bucket}`)) {
        // volatility proxy from the observed 1h move — labeled honestly
        const atrProxy = Math.min(20, Math.abs(t.change1h));
        yield {
          scanner: 'cross_chain_momentum',
          universe: 'multichain',
          instrumentId: `CRYPTO_SPOT://${t.chain}/${t.symbol}`,
          symbol: t.symbol,
          direction: 'buy',
          confidence: Math.round(45 + Math.min(30, t.change5m * 3)),
          edge: edgeForUniverse('multichain', atrProxy, 0.4),
          evidence: {
            chain: t.chain, change5m: +t.change5m.toFixed(2), change1h: +t.change1h.toFixed(2),
            volume24hUsd: Math.round(t.volume24hUsd ?? 0),
          },
        };
      }
    }
  }
}
