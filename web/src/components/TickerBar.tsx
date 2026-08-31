import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { fmtPx, fmtPct } from '../lib/format';

type Prices = Record<string, { price: number; changePct24h: number }>;
type Feeds = Record<string, { connected: boolean; stale: boolean }>;

export function TickerBar() {
  const [prices, setPrices] = useState<Prices>({});
  const [feeds, setFeeds] = useState<Feeds>({});

  useEffect(() => {
    void api
      .get<{ prices: Prices; feeds: Feeds }>('/api/market/prices')
      .then((r) => {
        setPrices(r.prices);
        setFeeds(r.feeds);
      })
      .catch(() => {});
    const un1 = wsClient.sub('prices', (d) => setPrices(d as Prices));
    const un2 = wsClient.sub('feedstatus', (d) => setFeeds(d as Feeds));
    return () => {
      un1();
      un2();
    };
  }, []);

  const anyStale = Object.values(feeds).some((f) => f.stale);
  const anyDown = Object.values(feeds).some((f) => !f.connected);

  return (
    <div className="ticker">
      {['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((sym) => {
        const p = prices[sym];
        return (
          <span key={sym}>
            <span className="sym">{sym.replace('USDT', '')} </span>
            {p ? (
              <>
                <span className="px">{fmtPx(p.price)}</span>{' '}
                <span className={p.changePct24h >= 0 ? 'up' : 'down'}>{fmtPct(p.changePct24h)}</span>
              </>
            ) : (
              <span className="dim">—</span>
            )}
          </span>
        );
      })}
      <span style={{ marginLeft: 'auto' }}>
        {anyDown ? (
          <span className="feed-down">■ FEED DOWN</span>
        ) : anyStale ? (
          <span className="feed-stale">■ FEED STALE</span>
        ) : Object.keys(feeds).length ? (
          <span className="feed-ok">■ FEED LIVE</span>
        ) : (
          <span className="dim">■ CONNECTING</span>
        )}
      </span>
    </div>
  );
}
