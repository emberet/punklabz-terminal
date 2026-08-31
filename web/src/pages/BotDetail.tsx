import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { BotSummary, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { AgentPanel } from '../components/AgentPanel';
import { arrow, fmtUsd, fmtPct, fmtPx, fmtTime, pillClass, pnlClass, shortAddr } from '../lib/format';
import { useAuth } from '../lib/auth';

interface Detail {
  bot: BotSummary;
  positions: { symbol: string; qty: number; avgEntry: number; markPrice: number; unrealizedPnlUsd: number }[];
  trades: TradeView[];
  metrics: { ts: number; equityUsd: number }[];
  config: unknown;
}

export function BotDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [err, setErr] = useState('');

  const load = () =>
    api.get<Detail>(`/api/bots/${id}`).then(setDetail).catch((e) => setErr(e.message));

  useEffect(() => {
    void load();
    const un = wsClient.sub(`bot:${id}`, () => void load());
    return un;
  }, [id]);

  if (err) return <div className="red">{err}</div>;
  if (!detail) return <div className="dim">loading…</div>;
  const { bot } = detail;
  const isOwner = user && (user.isAdmin || bot.ownerName === user.displayName);
  const totalPnl = bot.equityUsd - bot.initialBalanceUsd;
  const totalPnlPct = (totalPnl / bot.initialBalanceUsd) * 100;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title row" style={{ gap: 12 }}>
            {bot.name}
            <span className={`chip chip-${bot.status}`}>● {bot.status}</span>
            {bot.kind === 'house' && <span className="chip chip-house">house</span>}
          </div>
          <div className="page-sub">
            {bot.strategyType}
            {bot.ownerName ? ` · by ${bot.ownerName}` : ' · house bot'}
          </div>
        </div>
        {isOwner && bot.kind === 'quant' && (
          <div>
            {bot.status !== 'running' ? (
              <button className="primary" onClick={() => api.post(`/api/bots/${id}/start`).then(load)}>
                Start bot
              </button>
            ) : (
              <button className="danger" onClick={() => api.post(`/api/bots/${id}/stop`).then(load)}>
                Stop bot
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
        <div className="stat-tile">
          <div className="label">Equity</div>
          <div className="value">${fmtUsd(bot.equityUsd, 0)}</div>
        </div>
        <div className={`stat-tile ${totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : ''}`}>
          <div className="label">Total P&L</div>
          <div className="value" style={{ whiteSpace: 'nowrap' }}>
            {totalPnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(totalPnl), 0)} {arrow(totalPnl)}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{fmtPct(totalPnlPct)}</div>
        </div>
        <div className={`stat-tile ${bot.pnlPct24h > 0 ? 'pos' : bot.pnlPct24h < 0 ? 'neg' : ''}`}>
          <div className="label">24h</div>
          <div className="value">{fmtPct(bot.pnlPct24h)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Trades</div>
          <div className="value">{bot.tradeCount}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Cash</div>
          <div className="value">${fmtUsd(bot.cashUsd, 0)}</div>
        </div>
      </div>

      <AgentPanel
        botId={bot.id}
        botName={bot.name}
        isDsl={bot.strategyType === 'dsl'}
        config={detail.config}
      />

      <Panel title="Equity curve" noPad>
        <div style={{ padding: '12px 16px' }}>
          <Sparkline values={detail.metrics.map((m) => m.equityUsd)} height={90} />
        </div>
      </Panel>

      <Panel title="Open positions" noPad>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>symbol</th>
                <th className="num">qty</th>
                <th className="num">avg entry</th>
                <th className="num">mark</th>
                <th className="num">unrealized</th>
              </tr>
            </thead>
            <tbody>
              {detail.positions.length === 0 && (
                <tr><td colSpan={5} className="dim">Flat — no open positions.</td></tr>
              )}
              {detail.positions.map((p) => (
                <tr key={p.symbol}>
                  <td>{p.symbol.length > 20 ? shortAddr(p.symbol) : p.symbol}</td>
                  <td className="num">{p.qty.toPrecision(6)}</td>
                  <td className="num">{fmtPx(p.avgEntry)}</td>
                  <td className="num">{fmtPx(p.markPrice)}</td>
                  <td className="num">
                    <span className={`pill ${pillClass(p.unrealizedPnlUsd)}`}>
                      {p.unrealizedPnlUsd >= 0 ? '+' : ''}{fmtUsd(p.unrealizedPnlUsd)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Trade log" noPad>
        <div className="table-scroll">
          <table style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>time</th>
                <th>side</th>
                <th>symbol</th>
                <th className="num">qty</th>
                <th className="num">price</th>
                <th>why</th>
                <th className="num">realized</th>
              </tr>
            </thead>
            <tbody>
              {detail.trades.map((t) => (
                <tr key={t.id}>
                  <td className="dim">{fmtTime(t.ts)}</td>
                  <td className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>{t.side.toUpperCase()}</td>
                  <td>{t.symbol.length > 20 ? shortAddr(t.symbol) : t.symbol}</td>
                  <td className="num">{t.qty.toPrecision(6)}</td>
                  <td className="num">{fmtPx(t.price)}</td>
                  <td className="soft">{t.reason ?? '—'}</td>
                  <td className={`num ${pnlClass(t.realizedPnlUsd)}`}>
                    {t.side === 'sell' ? `${t.realizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(t.realizedPnlUsd)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="CONFIG ▸ JSON"
        term
        noPad
        right={
          <a onClick={() => setShowJson(!showJson)} style={{ cursor: 'pointer' }}>
            {showJson ? 'hide' : 'show'}
          </a>
        }
      >
        {showJson ? (
          <div className="config-preview" onClick={() => setShowJson(false)} style={{ cursor: 'pointer' }}>
            {JSON.stringify(detail.config, null, 2)}
          </div>
        ) : (
          <div
            className="panel-body dim"
            onClick={() => setShowJson(true)}
            style={{ cursor: 'pointer' }}
          >
            Raw strategy config — tap to show ▼
          </div>
        )}
      </Panel>

      <Link to="/" className="dim">← Back to the arena</Link>
    </div>
  );
}
