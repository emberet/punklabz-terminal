import WebSocket from 'ws';
import type { Candle } from '@punklabz/shared';
import { BaseFeed } from './feed.js';

// Fallback for regions where Binance serves 451. Coinbase product ids differ:
// BTC-USD etc. We keep Binance-style symbols (BTCUSDT) as the app-wide key.

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const REST_URL = 'https://api.exchange.coinbase.com';

const SYMBOL_MAP: Record<string, string> = {
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  SOLUSDT: 'SOL-USD',
};
const REVERSE_MAP = Object.fromEntries(Object.entries(SYMBOL_MAP).map(([k, v]) => [v, k]));

interface Building {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export class CoinbaseFeed extends BaseFeed {
  readonly name = 'coinbase';
  private ws: WebSocket | null = null;
  private stopped = false;
  private building = new Map<string, Building>(); // app symbol -> current 1m bar
  private open24h = new Map<string, number>();

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
    this.startWatchdog(() => this.ws?.terminate());
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.emitStatus(true, false);
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: Object.values(SYMBOL_MAP),
          channels: ['matches', 'ticker'],
        }),
      );
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ticker' && msg.product_id) {
          const symbol = REVERSE_MAP[msg.product_id];
          if (!symbol) return;
          const price = Number(msg.price);
          const open = Number(msg.open_24h ?? 0);
          this.open24h.set(symbol, open);
          this.emit('tick', {
            symbol,
            price,
            changePct24h: open > 0 ? ((price - open) / open) * 100 : 0,
          });
        } else if (msg.type === 'match' && msg.product_id) {
          const symbol = REVERSE_MAP[msg.product_id];
          if (!symbol) return;
          this.ingestMatch(symbol, Number(msg.price), Number(msg.size), Date.parse(msg.time));
        }
      } catch {
        // ignore
      }
    });

    const retry = () => {
      this.emitStatus(false, true);
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoffMs());
    };
    ws.on('close', retry);
    ws.on('error', () => ws.terminate());
  }

  /** Self-aggregate matches into 1m candles; emit on minute rollover. */
  private ingestMatch(symbol: string, price: number, size: number, ts: number) {
    const minute = Math.floor(ts / 60_000) * 60_000;
    const cur = this.building.get(symbol);
    if (!cur || cur.ts !== minute) {
      if (cur) {
        const candle: Candle = { symbol, interval: '1m', ts: cur.ts, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v };
        this.emit('candle', candle);
      }
      this.building.set(symbol, { ts: minute, o: price, h: price, l: price, c: price, v: size });
    } else {
      cur.h = Math.max(cur.h, price);
      cur.l = Math.min(cur.l, price);
      cur.c = price;
      cur.v += size;
    }
  }

  async backfill(symbol: string): Promise<{ m1: Candle[]; h1: Candle[] }> {
    const product = SYMBOL_MAP[symbol];
    const fetchCandles = async (granularity: number, interval: Candle['interval']): Promise<Candle[]> => {
      const res = await fetch(`${REST_URL}/products/${product}/candles?granularity=${granularity}`, {
        headers: { 'User-Agent': 'punklabz-terminal' },
      });
      if (!res.ok) throw new Error(`coinbase candles ${product}: HTTP ${res.status}`);
      // rows: [time(s), low, high, open, close, volume] newest first
      const rows = (await res.json()) as number[][];
      return rows
        .map((r) => ({
          symbol,
          interval,
          ts: r[0] * 1000,
          o: r[3],
          h: r[2],
          l: r[1],
          c: r[4],
          v: r[5],
        }))
        .sort((a, b) => a.ts - b.ts);
    };
    const [m1, h1] = await Promise.all([fetchCandles(60, '1m'), fetchCandles(3600, '1h')]);
    return { m1, h1 };
  }
}
