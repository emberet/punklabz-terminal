import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { BotSummary, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { fmtUsd, fmtPct, fmtPx, fmtTime, pnlClass, shortAddr } from '../lib/format';
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

  return (
    <div>
      <Panel
        title={`BOT // ${bot.name}`}
        right={
          <span className="row" style={{ gap: 8 }}>
            <span className={`led ${bot.status}`} />
            <span className="dim">{bot.status}</span>
            {isOwner && bot.kind === 'quant' && (
              <>
                {bot.status !== 'running' ? (
                  <button className="primary" onClick={() => api.post(`/api/bots/${id}/start`).then(load)}>
                    start
                  </button>
                ) : (
                  <button className="danger" onClick={() => api.post(`/api/bots/${id}/stop`).then(load)}>
                    stop
                  </button>
                )}
              </>
            )}
          </span>
        }
      >
        <div className="row" style={{ gap: 32 }}>
          <div>
            <div className="dim">EQUITY</div>
            <div className="bot-equity">${fmtUsd(bot.equityUsd)}</div>
          </div>
          <div>
            <div className="dim">TOTAL P&L</div>
            <div className={pnlClass(totalPnl)}>
              {totalPnl >= 0 ? '+' : ''}
              {fmtUsd(totalPnl)} ({fmtPct((totalPnl / bot.initialBalanceUsd) * 100)})
            </div>
          </div>
          <div>
            <div className="dim">24H</div>
            <div className={pnlClass(bot.pnlPct24h)}>{fmtPct(bot.pnlPct24h)}</div>
          </div>
          <div>
            <div className="dim">TRADES</div>
            <div>{bot.tradeCount}</div>
          </div>
          <div>
            <div className="dim">CASH</div>
            <div>${fmtUsd(bot.cashUsd)}</div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Sparkline values={detail.metrics.map((m) => m.equityUsd)} height={80} />
        </div>
      </Panel>

      <Panel title="OPEN POSITIONS" noPad>
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
              <tr><td colSpan={5} className="dim">flat — no open positions</td></tr>
            )}
            {detail.positions.map((p) => (
              <tr key={p.symbol}>
                <td>{p.symbol.length > 20 ? shortAddr(p.symbol) : p.symbol}</td>
                <td className="num">{p.qty.toPrecision(6)}</td>
                <td className="num">{fmtPx(p.avgEntry)}</td>
                <td className="num">{fmtPx(p.markPrice)}</td>
                <td className={`num ${pnlClass(p.unrealizedPnlUsd)}`}>
                  {p.unrealizedPnlUsd >= 0 ? '+' : ''}{fmtUsd(p.unrealizedPnlUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="TRADE LOG" noPad>
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>side</th>
              <th>symbol</th>
              <th className="num">qty</th>
              <th className="num">price</th>
              <th className="num">fee</th>
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
                <td className="num dim">{fmtUsd(t.feeUsd)}</td>
                <td className={`num ${pnlClass(t.realizedPnlUsd)}`}>
                  {t.side === 'sell' ? `${t.realizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(t.realizedPnlUsd)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="CONFIG">
        <div className="mono-block">{JSON.stringify(detail.config, null, 2)}</div>
      </Panel>

      <Link to="/" className="dim">← back to trading floor</Link>
    </div>
  );
}
