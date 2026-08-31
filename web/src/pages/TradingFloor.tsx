import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotSummary, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { MemesPanel } from '../components/MemesPanel';
import { arrow, fmtUsd, fmtPct, fmtPx, fmtTime, pillClass, pnlClass, shortAddr } from '../lib/format';

const STRAT_META: Record<string, { label: string; market: string; tf: string; risk: string }> = {
  momentum: { label: 'Momentum', market: 'BTC · ETH · SOL', tf: '15m', risk: 'medium' },
  mean_reversion: { label: 'Mean reversion', market: 'BTC · ETH · SOL', tf: '5m', risk: 'medium' },
  grid: { label: 'Grid', market: 'BTC · ETH · SOL', tf: '1m', risk: 'low' },
  pump_sniper: { label: 'Pump sniper', market: 'pump.fun', tf: 'live', risk: 'degen' },
  herd_sentiment: { label: 'Herd sentiment', market: 'pump.fun', tf: 'live', risk: 'degen' },
  dsl: { label: 'Custom', market: 'majors', tf: '—', risk: 'custom' },
};

interface SeasonInfo {
  season: { id: number; name: string; endsAt: number };
  countdownMs: number;
}

function countdownText(ms: number): string {
  if (ms <= 0) return 'closing…';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export function TradingFloor() {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [tape, setTape] = useState<TradeView[]>([]);
  const [sparks, setSparks] = useState<Record<number, number[]>>({});
  const [season, setSeason] = useState<SeasonInfo | null>(null);

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
    void api.get<SeasonInfo>('/api/seasons/current').then(setSeason).catch(() => {});
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

  const totalEquity = bots.reduce((s, b) => s + b.equityUsd, 0);
  const totalInitial = bots.reduce((s, b) => s + b.initialBalanceUsd, 0);
  const totalTrades = bots.reduce((s, b) => s + b.tradeCount, 0);
  const pnl24hAvg = bots.length ? bots.reduce((s, b) => s + b.pnlPct24h, 0) / bots.length : 0;
  const nextEpochMs = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000 - Date.now();

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Arena</div>
          <div className="page-sub">Live bots trading real market data with simulated balances.</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 16 }}>
        <div className="stat-tile invert">
          <div className="label">Arena equity</div>
          <div className="value">${fmtUsd(totalEquity, 0)}</div>
        </div>
        <div className={`stat-tile ${totalEquity - totalInitial > 0 ? 'pos' : totalEquity - totalInitial < 0 ? 'neg' : ''}`}>
          <div className="label">All-time P&L</div>
          <div className="value">
            {totalEquity - totalInitial >= 0 ? '+' : '−'}${fmtUsd(Math.abs(totalEquity - totalInitial), 0)}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Avg 24h</div>
          <div className="value">{fmtPct(pnl24hAvg)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Trades</div>
          <div className="value">{totalTrades}</div>
        </div>
        <div className="stat-tile">
          <div className="label">{season ? season.season.name : 'Next payout'}</div>
          <div className="value">
            {season ? countdownText(season.countdownMs) : countdownText(nextEpochMs)}
          </div>
        </div>
      </div>

      <div className="grid grid-bots" style={{ marginBottom: 14 }}>
        {bots.map((b) => {
          const meta = STRAT_META[b.strategyType] ?? STRAT_META.dsl;
          const sells = Math.max(1, Math.round(b.tradeCount / 2));
          const winRate = b.tradeCount > 0 ? Math.round((b.winCount / sells) * 100) : 0;
          return (
            <Link key={b.id} to={`/bots/${b.id}`} style={{ color: 'inherit' }}>
              <div className="bot-card">
                <div className="bot-head">
                  <span className="bot-name">{b.name}</span>
                  {b.kind === 'house' && <span className="chip chip-house">house</span>}
                  <span className={`chip chip-${b.status}`} style={{ marginLeft: 'auto' }}>
                    ● {b.status}
                  </span>
                </div>
                <div className="bot-pnl-row">
                  <span className={`pill ${pillClass(b.pnlPct24h)}`}>
                    {fmtPct(b.pnlPct24h)} {arrow(b.pnlPct24h)}
                  </span>
                  <span className="when">24h</span>
                </div>
                <div className="bot-equity-label">Equity</div>
                <div className="bot-equity">${fmtUsd(b.equityUsd, 0)}</div>
                <div className="bot-spark">
                  <Sparkline values={sparks[b.id] ?? []} />
                </div>
                <div className="bot-meta">
                  {meta.label} · {meta.market} · {meta.tf}
                  {b.ownerName ? ` · by ${b.ownerName}` : ''}
                </div>
                <div className="bot-stats-line">
                  {b.tradeCount > 0 ? `${winRate}% win rate · ` : ''}
                  {b.tradeCount} trades · {meta.risk} risk
                </div>
                <div className="bot-cta">VIEW BOT →</div>
              </div>
            </Link>
          );
        })}
      </div>

      <MemesPanel />

      <Panel title="TAPE ▸ ALL BOTS" term noPad right={<span className="chip chip-running">LIVE</span>}>
        <div className="tape">
          {tape.length === 0 && <div className="tape-row dim">waiting for trades…</div>}
          {tape.map((t, i) => (
            <div className="tape-row" key={`${t.id}-${i}`}>
              <span className="t">{fmtTime(t.ts)}</span>
              <span className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>{t.side.toUpperCase()}</span>
              <span>{t.symbol.length > 20 ? shortAddr(t.symbol) : t.symbol}</span>
              <span className="num">{fmtPx(t.price)}</span>
              <span className="dim">{t.botName ?? `bot #${t.botId}`}</span>
              {t.reason && <span className="soft">{t.reason}</span>}
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
