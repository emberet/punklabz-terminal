import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotSummary, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { MemesPanel } from '../components/MemesPanel';
import { MarketChart } from '../components/MarketChart';
import { GlobalProcess } from '../components/GlobalProcess';
import { useRef } from 'react';
import { arrow, fmtUsd, fmtPct, fmtPx, fmtTime, pillClass, pnlClass, shortAddr } from '../lib/format';
import { asciiSpark, machineAvatar, machineId, CLASS_LABELS, HOUSE_TAGLINES } from '../lib/ascii';

interface SeasonInfo {
  season: { id: number; name: string; endsAt: number };
  countdownMs: number;
}

function countdownText(ms: number): string {
  if (ms <= 0) return 'closing…';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d}D ${h}H` : `${h}H ${m}M`;
}

export function TradingFloor() {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [tape, setTape] = useState<TradeView[]>([]);
  const [sparks, setSparks] = useState<Record<number, number[]>>({});
  const [season, setSeason] = useState<SeasonInfo | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [regime, setRegime] = useState<{ symbol: string; regime: string | null }[]>([]);
  const prevRanks = useRef<Map<number, number>>(new Map());

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
    const loadRegime = () =>
      api.get<{ readings: { symbol: string; regime: string | null }[] }>('/api/market/regime')
        .then((r) => setRegime(r.readings)).catch(() => {});
    void loadRegime();
    const rt = setInterval(loadRegime, 120_000);
    const unTape = wsClient.sub('tape', (d) => {
      setTape((t) => [d as TradeView, ...t].slice(0, 50));
      void load();
    });
    const interval = setInterval(load, 30_000);
    return () => {
      unTape();
      clearInterval(interval);
      clearInterval(rt);
    };
  }, []);

  const race = [...bots].sort((a, b) => b.pnlPct24h - a.pnlPct24h);
  const rankDelta = (botId: number, rank: number) => {
    const prev = prevRanks.current.get(botId);
    return prev === undefined ? 0 : prev - rank;
  };
  setTimeout(() => {
    race.forEach((b, i) => prevRanks.current.set(b.id, i + 1));
  }, 0);
  const totalTrades = bots.reduce((s, b) => s + b.tradeCount, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Arena // Live</div>
          <div className="page-sub">
            {bots.length} MACHINES ACTIVE · {totalTrades} TRADES ·{' '}
            {season ? `${season.season.name} ENDS ${countdownText(season.countdownMs)}` : 'SESSION OPEN'} ·
            simulated balances, real market data
          </div>
          <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            {regime.filter((r) => r.regime).map((r) => (
              <span key={r.symbol} className={`regime-chip regime-${String(r.regime).replace(/ /g, '-')}`}>
                {r.symbol.replace('USDT', '')}: {r.regime}
              </span>
            ))}
          </div>
        </div>
      </div>

      <GlobalProcess />

      <MarketChart />

      <Panel title="LIVE BOT RACE" sub="session return, re-ranked in real time" noPad>
        <div className="table-scroll">
          <table style={{ minWidth: 560 }}>
            <tbody>
              {race.map((b, i) => {
                const delta = rankDelta(b.id, i + 1);
                return (
                <tr key={b.id} className={delta > 0 ? 'race-moved' : delta < 0 ? 'race-moved-down' : ''}>
                  <td className={i < 3 ? 'phos' : 'dim'} style={{ width: 34 }}>
                    {String(i + 1).padStart(2, '0')}
                    {delta > 0 && <span className="race-up"> ↑{delta}</span>}
                    {delta < 0 && <span className="race-down"> ↓{-delta}</span>}
                  </td>
                  <td>
                    <span className="bot-avatar" style={{ marginRight: 8 }}>{machineAvatar(b.id, b.name)}</span>
                    <Link to={`/bots/${b.id}`}>{b.name}</Link>
                    {b.kind === 'house' && <span className="chip chip-house" style={{ marginLeft: 6 }}>house</span>}
                  </td>
                  <td className="ascii-spark" style={{ width: 120 }}>{asciiSpark(sparks[b.id] ?? [], 12)}</td>
                  <td className="num" style={{ width: 110 }}>
                    <span className={`pill ${pillClass(b.pnlPct24h)}`}>
                      {fmtPct(b.pnlPct24h)} {arrow(b.pnlPct24h)}
                    </span>
                  </td>
                  <td className="num dim" style={{ width: 100 }}>${fmtUsd(b.equityUsd, 0)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-bots" style={{ marginBottom: 12 }}>
        {bots.map((b) => {
          const meta = CLASS_LABELS[b.strategyType] ?? CLASS_LABELS.dsl;
          const tagline = HOUSE_TAGLINES[b.strategyType];
          const sells = Math.max(1, Math.round(b.tradeCount / 2));
          const winRate = b.tradeCount > 0 ? Math.round((b.winCount / sells) * 100) : 0;
          return (
            <Link key={b.id} to={`/bots/${b.id}`} style={{ color: 'inherit' }}>
              <div className="bot-card">
                <span className="machine-id">{machineId(b.id, b.name)}</span>
                <div className="bot-head">
                  <span className={`bot-avatar ${b.status === 'running' ? 'sigil-running' : ''}`}>{machineAvatar(b.id, b.name)}</span>
                  <span className="bot-name">{b.name}</span>
                </div>
                <div className="bot-pnl-row">
                  <span className={`pill ${pillClass(b.pnlPct24h)}`}>
                    {fmtPct(b.pnlPct24h)} {arrow(b.pnlPct24h)}
                  </span>
                  <span className="when">24H</span>
                  <span className={`chip chip-${b.status}`} style={{ marginLeft: 10 }}>● {b.status}</span>
                </div>
                <div className="bot-equity-label">Equity</div>
                <div className="bot-equity">${fmtUsd(b.equityUsd, 0)}</div>
                <div className="bot-spark">
                  <Sparkline values={sparks[b.id] ?? []} />
                </div>
                <div className="bot-meta">
                  CLASS: {meta}
                  {b.ownerName ? ` · OPERATOR: ${b.ownerName}` : ''}
                </div>
                <div className="bot-stats-line">
                  {tagline ? `"${tagline}"` : `${b.tradeCount > 0 ? `${winRate}% win rate · ` : ''}${b.tradeCount} trades`}
                </div>
                <div className="bot-cta">OPEN DOSSIER →</div>
              </div>
            </Link>
          );
        })}
      </div>

      <MemesPanel />

      <Panel title="TAPE ▸ ALL MACHINES" term noPad right={<span className="chip chip-running">LIVE</span>}>
        <div className="tape">
          {tape.length === 0 && <div className="tape-row dim">waiting for trades…</div>}
          {tape.map((t, i) => (
            <div key={`${t.id}-${i}`}>
              <div
                className={`tape-row ${i === 0 ? `tape-new ${t.side === 'sell' ? 'tape-sell' : ''}` : ''}`}
                style={{ cursor: t.reason ? 'pointer' : 'default' }}
                onClick={() => setExpanded(expanded === t.id ? null : t.id)}
              >
                <span className="t">{fmtTime(t.ts)}</span>
                <span className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>{t.side.toUpperCase()}</span>
                <span>{t.symbol.length > 20 ? shortAddr(t.symbol) : t.symbol}</span>
                <span className="num">{fmtPx(t.price)}</span>
                <span className="dim">{t.botName ?? `M-${t.botId}`}</span>
                {t.side === 'sell' && (
                  <span className={pnlClass(t.realizedPnlUsd)}>
                    {t.realizedPnlUsd >= 0 ? '+' : ''}
                    {fmtUsd(t.realizedPnlUsd)}
                  </span>
                )}
                {t.reason && <span className="dim">{expanded === t.id ? '▲' : '▼'}</span>}
              </div>
              {expanded === t.id && t.reason && (
                <div className="tape-row" style={{ background: 'var(--tint-hover)' }}>
                  <span className="dim">WHY:</span>
                  <span className="soft">{t.reason}</span>
                  <span className="phos">[ DECISION LOGGED ]</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
