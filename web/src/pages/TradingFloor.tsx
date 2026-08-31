import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotSummary, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { fmtUsd, fmtPct, fmtPx, fmtTime, pnlClass, shortAddr } from '../lib/format';

export function TradingFloor() {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [tape, setTape] = useState<TradeView[]>([]);
  const [sparks, setSparks] = useState<Record<number, number[]>>({});

  const load = () =>
    api.get<{ bots: BotSummary[] }>('/api/bots').then((r) => {
      setBots(r.bots);
      for (const b of r.bots) {
        void api
          .get<{ metrics: { equityUsd: number }[] }>(`/api/bots/${b.id}`)
          .then((d) => setSparks((s) => ({ ...s, [b.id]: d.metrics.map((m) => m.equityUsd) })))
          .catch(() => {});
      }
    });

  useEffect(() => {
    void load();
    const unTape = wsClient.sub('tape', (d) => {
      setTape((t) => [d as TradeView, ...t].slice(0, 50));
      void load();
    });
    const interval = setInterval(load, 30_000);
    return () => {
      unTape();
      clearInterval(interval);
    };
  }, []);

  return (
    <div>
      <div className="grid grid-bots">
        {bots.map((b) => (
          <Link key={b.id} to={`/bots/${b.id}`} style={{ color: 'inherit' }}>
            <div className="bot-card">
              <div className="bot-head">
                <span className={`led ${b.status}`} />
                <span className="bot-name">{b.name}</span>
                <span className={`bot-tag ${b.kind}`}>{b.kind}</span>
              </div>
              <div className="bot-stats">
                <span className="bot-equity">${fmtUsd(b.equityUsd)}</span>
                <span className={pnlClass(b.pnlPct24h)}>{fmtPct(b.pnlPct24h)} 24h</span>
                <span className="dim">{b.tradeCount} trades</span>
              </div>
              <div className="bot-spark">
                <Sparkline values={sparks[b.id] ?? []} />
              </div>
              <div className="bot-meta">
                {b.strategyType} · realized {b.realizedPnlUsd >= 0 ? '+' : ''}
                {fmtUsd(b.realizedPnlUsd)} · unrealized {b.unrealizedPnlUsd >= 0 ? '+' : ''}
                {fmtUsd(b.unrealizedPnlUsd)}
                {b.ownerName ? ` · by ${b.ownerName}` : ''}
              </div>
            </div>
          </Link>
        ))}
      </div>

      <Panel title="TAPE // ALL BOTS" noPad>
        <div className="tape">
          {tape.length === 0 && <div className="tape-row dim">waiting for trades…</div>}
          {tape.map((t, i) => (
            <div className="tape-row" key={`${t.id}-${i}`}>
              <span className="t">{fmtTime(t.ts)}</span>
              <span className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>{t.side.toUpperCase()}</span>
              <span>{t.symbol.length > 20 ? shortAddr(t.symbol) : t.symbol}</span>
              <span className="num">{fmtPx(t.price)}</span>
              <span className="dim">{t.botName ?? `bot #${t.botId}`}</span>
              {t.side === 'sell' && (
                <span className={pnlClass(t.realizedPnlUsd)}>
                  {t.realizedPnlUsd >= 0 ? '+' : ''}
                  {fmtUsd(t.realizedPnlUsd)}
                </span>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
