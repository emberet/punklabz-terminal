import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityEventView, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { fmtTime, fmtUsd, shortAddr } from '../lib/format';

type RailItem =
  | { kind: 'trade'; ts: number; trade: TradeView }
  | { kind: 'event'; ts: number; event: ActivityEventView };

export function ActivityRail() {
  const [items, setItems] = useState<RailItem[]>([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('plz.rail') === 'closed';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    void api.get<{ events: ActivityEventView[] }>('/api/feed?limit=25').then((r) => {
      setItems(r.events.map((e) => ({ kind: 'event', ts: e.ts, event: e })));
    }).catch(() => {});
    const un1 = wsClient.sub('tape', (d) => {
      const trade = d as TradeView;
      const item: RailItem = { kind: 'trade', ts: trade.ts, trade };
      setItems((prev) => [item, ...prev].slice(0, 60));
    });
    const un2 = wsClient.sub('feed', (d) => {
      const event = d as ActivityEventView;
      const item: RailItem = { kind: 'event', ts: event.ts, event };
      setItems((prev) => [item, ...prev].slice(0, 60));
    });
    return () => {
      un1();
      un2();
    };
  }, []);

  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem('plz.rail', collapsed ? 'open' : 'closed');
    } catch { /* private mode */ }
  };

  if (collapsed) {
    return (
      <div className="rail rail-collapsed" onClick={toggle} title="open system feed">
        <div className="rail-vert">SYSTEM FEED ◂</div>
      </div>
    );
  }

  return (
    <div className="rail">
      <div className="rail-head">
        System feed
        <span className="spacer" />
        <a onClick={toggle} style={{ cursor: 'pointer', color: 'var(--text-dim)' }}>▸</a>
      </div>
      <div className="rail-body">
        {items.length === 0 && <div className="rail-row dim">listening…</div>}
        {items.map((it, i) =>
          it.kind === 'trade' ? (
            <div className="rail-row" key={`t${it.trade.id}-${i}`}>
              <span className="t">{fmtTime(it.ts)}</span>
              <Link to={`/bots/${it.trade.botId}`}>{it.trade.botName ?? `M-${it.trade.botId}`}</Link>{' '}
              <span className={it.trade.side === 'buy' ? 'phos' : 'red'}>{it.trade.side.toUpperCase()}</span>{' '}
              {it.trade.symbol.length > 12 ? shortAddr(it.trade.symbol) : it.trade.symbol.replace('USDT', '')}
              {it.trade.side === 'sell' && (
                <span className={it.trade.realizedPnlUsd >= 0 ? ' phos' : ' red'}>
                  {' '}{it.trade.realizedPnlUsd >= 0 ? '+' : ''}{fmtUsd(it.trade.realizedPnlUsd, 0)}
                </span>
              )}
            </div>
          ) : (
            <div className="rail-row" key={`e${it.event.id}-${i}`}>
              <span className="t">{fmtTime(it.ts)}</span>
              {railEventText(it.event)}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function railEventText(e: ActivityEventView) {
  const actor = e.actorUserId ? <Link to={`/u/${e.actorUserId}`}>{e.actorName}</Link> : null;
  const bot = e.botId ? <Link to={`/bots/${e.botId}`}>{e.botName ?? `M-${e.botId}`}</Link> : null;
  switch (e.type) {
    case 'deploy': return <>{actor} DEPLOYED {bot}</>;
    case 'clone': return <>{actor} CLONED {bot}</>;
    case 'badge': return <>{actor} EARNED <span className="amber">{String(e.payload.badge).toUpperCase()}</span></>;
    case 'big_win': return <>{bot} BANKED <span className="phos">+${Number(e.payload.pnlUsd ?? 0).toFixed(0)}</span></>;
    case 'rank_change': return <>{bot} ENTERED TOP 3</>;
    case 'season_start': return <><span className="phos">{String(e.payload.name)}</span> ONLINE</>;
    case 'season_end': return <><span className="phos">{String(e.payload.name)}</span> ARCHIVED</>;
    default: return <>{e.type}</>;
  }
}
