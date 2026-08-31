import WebSocket from 'ws';
import { MAJOR_SYMBOLS, type Candle } from '@punklabz/shared';
import { BaseFeed } from './feed.js';

const WS_URL = 'wss://stream.binance.com:9443/stream';
const REST_URL = 'https://api.binance.com/api/v3/klines';

export class BinanceFeed extends BaseFeed {
  readonly name = 'binance';
  private ws: WebSocket | null = null;
  private stopped = false;

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
    this.startWatchdog(() => {
      this.ws?.terminate();
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const streams = MAJOR_SYMBOLS.flatMap((s) => [
      `${s.toLowerCase()}@kline_1m`,
      `${s.toLowerCase()}@miniTicker`,
    ]).join('/');
    const ws = new WebSocket(`${WS_URL}?streams=${streams}`);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.emitStatus(true, false);
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        const data = msg.data;
        if (!data) return;
        if (data.e === 'kline' && data.k?.x === true) {
          const k = data.k;
          const candle: Candle = {
            symbol: data.s,
            interval: '1m',
            ts: k.t,
            o: Number(k.o),
            h: Number(k.h),
            l: Number(k.l),
            c: Number(k.c),
            v: Number(k.v),
          };
          this.emit('candle', candle);
        } else if (data.e === '24hrMiniTicker') {
          const price = Number(data.c);
          const open = Number(data.o);
          this.emit('tick', {
            symbol: data.s,
            price,
            changePct24h: open > 0 ? ((price - open) / open) * 100 : 0,
          });
        }
      } catch {
        // malformed frame: ignore
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

  async backfill(symbol: string): Promise<{ m1: Candle[]; h1: Candle[] }> {
    const fetchKlines = async (interval: string): Promise<Candle[]> => {
      const res = await fetch(`${REST_URL}?symbol=${symbol}&interval=${interval}&limit=500`);
      if (!res.ok) throw new Error(`binance klines ${symbol} ${interval}: HTTP ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      return rows.map((r) => ({
        symbol,
        interval: interval as Candle['interval'],
        ts: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
      }));
    };
    const [m1, h1] = await Promise.all([fetchKlines('1m'), fetchKlines('1h')]);
    return { m1, h1 };
  }

  /** REST gap-fill after reconnect. */
  async fillGap(symbol: string, sinceTs: number): Promise<Candle[]> {
    const res = await fetch(`${REST_URL}?symbol=${symbol}&interval=1m&startTime=${sinceTs}&limit=1000`);
    if (!res.ok) return [];
    const rows = (await res.json()) as unknown[][];
    return rows.map((r) => ({
      symbol,
      interval: '1m' as const,
      ts: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    }));
  }
}
