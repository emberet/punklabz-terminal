import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from './Panel';
import { fmtPx, fmtTime } from '../lib/format';
import { useFx } from '../lib/fx';

interface Marker {
  ts: number;
  price: number;
  side: 'buy' | 'sell';
  bot: string;
  fresh: boolean;
}

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const W = 720;
const H = 200;

/**
 * Central arena chart: last ~3h of 1m closes, progressive draw on mount,
 * machine BUY/SELL events land as markers with a brief label flash.
 */
export function MarketChart() {
  const { mode } = useFx();
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [drawn, setDrawn] = useState(mode !== 'full');
  const pathRef = useRef<SVGPolylineElement>(null);

  useEffect(() => {
    setDrawn(mode !== 'full');
    void api
      .get<{ candles: Candle[] }>(`/api/market/candles?symbol=${symbol}&interval=1m&limit=180`)
      .then((r) => setCandles(r.candles));
    setMarkers([]);
    const t = setInterval(() => {
      void api
        .get<{ candles: Candle[] }>(`/api/market/candles?symbol=${symbol}&interval=1m&limit=180`)
        .then((r) => setCandles(r.candles));
    }, 60_000);
    return () => clearInterval(t);
  }, [symbol, mode]);

  useEffect(() => {
    const un = wsClient.sub('tape', (d) => {
      const trade = d as TradeView;
      if (trade.symbol !== symbol) return;
      setMarkers((m) => [
        ...m.slice(-30),
        { ts: trade.ts, price: trade.price, side: trade.side, bot: trade.botName ?? `M-${trade.botId}`, fresh: true },
      ]);
      setTimeout(
        () => setMarkers((m) => m.map((mk) => (mk.ts === trade.ts ? { ...mk, fresh: false } : mk))),
        1400,
      );
    });
    return un;
  }, [symbol]);

  // progressive draw via stroke-dash
  useEffect(() => {
    if (drawn || !pathRef.current || candles.length < 2) return;
    const el = pathRef.current;
    const len = el.getTotalLength();
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(len);
    el.style.transition = 'stroke-dashoffset 700ms steps(24)';
    requestAnimationFrame(() => {
      el.style.strokeDashoffset = '0';
    });
    const t = setTimeout(() => setDrawn(true), 750);
    return () => clearTimeout(t);
  }, [candles, drawn]);

  const geom = useMemo(() => {
    if (candles.length < 2) return null;
    const t0 = candles[0].ts;
    const t1 = candles[candles.length - 1].ts;
    const min = Math.min(...candles.map((c) => c.l));
    const max = Math.max(...candles.map((c) => c.h));
    const range = max - min || 1;
    const x = (ts: number) => ((ts - t0) / (t1 - t0 || 1)) * W;
    const y = (p: number) => H - 8 - ((p - min) / range) * (H - 16);
    return {
      x, y, min, max,
      pts: candles.map((c) => `${x(c.ts).toFixed(1)},${y(c.c).toFixed(1)}`).join(' '),
    };
  }, [candles]);

  const last = candles[candles.length - 1];

  return (
    <Panel
      title="MARKET STATE"
      sub="1m closes · machine actions overlay"
      noPad
      right={
        <span className="tabs" style={{ display: 'inline-flex' }}>
          {SYMBOLS.map((s) => (
            <button key={s} className={s === symbol ? 'active' : ''} onClick={() => setSymbol(s)}>
              {s.replace('USDT', '')}
            </button>
          ))}
        </span>
      }
    >
      <div style={{ padding: '10px 14px', cursor: 'crosshair' }}>
        {!geom ? (
          <div className="dim">acquiring tape…</div>
        ) : (
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={0} y1={H * f} x2={W} y2={H * f} stroke="var(--border)" strokeWidth={0.5} strokeDasharray="3 5" />
            ))}
            <polyline ref={pathRef} points={geom.pts} fill="none" stroke="var(--phosphor)" strokeWidth={1.2} />
            {markers.map((m, i) => {
              const mx = geom.x(m.ts);
              const my = geom.y(m.price);
              const color = m.side === 'buy' ? 'var(--signal)' : 'var(--red)';
              return (
                <g key={`${m.ts}-${i}`}>
                  <line x1={mx} y1={my - (m.fresh ? 26 : 7)} x2={mx} y2={my + (m.fresh ? 26 : 7)} stroke={color} strokeWidth={m.fresh ? 1.4 : 0.9} />
                  <rect x={mx - 2.5} y={my - 2.5} width={5} height={5} fill={color} />
                  {m.fresh && (
                    <text x={Math.min(mx + 6, W - 120)} y={Math.max(my - 12, 12)} fill={color} fontSize={10} fontFamily="var(--font)">
                      {m.bot} {m.side.toUpperCase()} {fmtPx(m.price)}
                    </text>
                  )}
                </g>
              );
            })}
            <text x={W - 4} y={12} fill="var(--text-soft)" fontSize={10} textAnchor="end" fontFamily="var(--font)">
              H {fmtPx(geom.max)}
            </text>
            <text x={W - 4} y={H - 4} fill="var(--text-soft)" fontSize={10} textAnchor="end" fontFamily="var(--font)">
              L {fmtPx(geom.min)}
            </text>
          </svg>
        )}
        {last && (
          <div className="row dim" style={{ fontSize: 10, marginTop: 4 }}>
            <span>{symbol} · last {fmtPx(last.c)} · {fmtTime(last.ts)}</span>
            <span className="spacer" />
            <span>{markers.length} machine actions in window</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
