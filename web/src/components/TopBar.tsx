import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { fmtPx, fmtPct } from '../lib/format';
import { NumberTicker } from './motion/NumberTicker';

type Prices = Record<string, { price: number; changePct24h: number }>;
type Feeds = Record<string, { connected: boolean; stale: boolean }>;

const CONTRACT_ADDRESS = '0x3d4fc26d757ee83ae012a159be7bde1ec3dc40cd';
const CONTRACT_EXPLORER_URL = `https://robinhoodchain.blockscout.com/address/${CONTRACT_ADDRESS}`;

interface LiveMini {
  mode: string;
  halted: boolean;
}

interface NetStats {
  machinesOnline: number;
  tradesToday: number;
  operatorsConnected?: number;
  backtestsRunning?: number;
  season: { name: string; endsAt: number } | null;
}

export function TopBar() {
  const [prices, setPrices] = useState<Prices>({});
  const [feeds, setFeeds] = useState<Feeds>({});
  const [stats, setStats] = useState<NetStats | null>(null);
  const [live, setLive] = useState<LiveMini | null>(null);
  const [clock, setClock] = useState('');
  const [flashes, setFlashes] = useState<Record<string, string>>({});

  const applyPrices = (next: Prices) => {
    setPrices((prev) => {
      const f: Record<string, string> = {};
      for (const [sym, p] of Object.entries(next)) {
        const old = prev[sym]?.price;
        if (old !== undefined && p.price !== old) f[sym] = p.price > old ? 'flash-pos' : 'flash-neg';
      }
      if (Object.keys(f).length) {
        setFlashes(f);
        setTimeout(() => setFlashes({}), 900);
      }
      return next;
    });
  };

  useEffect(() => {
    void api.get<{ prices: Prices; feeds: Feeds }>('/api/market/prices').then((r) => {
      applyPrices(r.prices);
      setFeeds(r.feeds);
    }).catch(() => {});
    const loadStats = () => api.get<NetStats>('/api/network/stats').then(setStats).catch(() => {});
    const loadLive = () => api.get<LiveMini>('/api/live/status').then(setLive).catch(() => {});
    void loadStats();
    void loadLive();
    const unLive = wsClient.sub('live', () => void loadLive());
    const un1 = wsClient.sub('prices', (d) => applyPrices(d as Prices));
    const un2 = wsClient.sub('feedstatus', (d) => setFeeds(d as Feeds));
    const t1 = setInterval(loadStats, 60_000);
    const t2 = setInterval(
      () => setClock(new Date().toISOString().slice(11, 19)),
      1000,
    );
    return () => {
      un1();
      un2();
      unLive();
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const anyStale = Object.values(feeds).some((f) => f.stale);
  const anyDown = Object.values(feeds).some((f) => !f.connected);

  return (
    <div className="topbar">
      <span className="node">PUNKLABZ<span style={{ opacity: 0.5 }}>▮</span></span>
      <a
        className="contract-address"
        href={CONTRACT_EXPLORER_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`PunkLabz contract address ${CONTRACT_ADDRESS}`}
        title="View contract on Robinhood Chain Explorer"
      >
        <span>CA-</span> {CONTRACT_ADDRESS}
      </a>
      <span className="stat dim">NODE 042</span>
      {['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((sym) => {
        const p = prices[sym];
        return (
          <span key={sym} className={flashes[sym] ?? ''}>
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
      {stats && (
        <>
          <span className="stat">MACHINES <b><NumberTicker value={stats.machinesOnline} /></b></span>
          <span className="stat">TRADES <b><NumberTicker value={stats.tradesToday} /></b></span>
          {stats.operatorsConnected !== undefined && (
            <span className="stat">OPERATORS <b><NumberTicker value={stats.operatorsConnected} /></b></span>
          )}
          {(stats.backtestsRunning ?? 0) > 0 && (
            <span className="stat amber">BACKTESTS <b>{stats.backtestsRunning}</b></span>
          )}
        </>
      )}
      {live && (
        <span className={live.halted ? 'red' : live.mode === 'simulation' ? 'dim' : 'amber'}>
          {live.halted ? '■ EXEC HALTED' : live.mode === 'simulation' ? '○ PAPER NETWORK' : `● ${live.mode.toUpperCase()} MODE`}
        </span>
      )}
      <span className="clock">
        {anyDown ? (
          <span className="feed-down">■ FEED DOWN </span>
        ) : anyStale ? (
          <span className="feed-stale">■ STALE </span>
        ) : (
          <span className="feed-ok">■ LIVE </span>
        )}
        UTC {clock}
      </span>
    </div>
  );
}
