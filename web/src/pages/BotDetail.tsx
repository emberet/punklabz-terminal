import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { BotSummary, TradeView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { AgentPanel } from '../components/AgentPanel';
import { PersonaPanel, type AppliedMod, type Persona } from '../components/PersonaPanel';
import { machineAvatar, machineId, CLASS_LABELS } from '../lib/ascii';
import { arrow, fmtUsd, fmtPct, fmtPx, fmtTime, pillClass, pnlClass, shortAddr } from '../lib/format';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/pageMeta';

interface Detail {
  bot: BotSummary;
  positions: { symbol: string; qty: number; avgEntry: number; markPrice: number; unrealizedPnlUsd: number }[];
  trades: TradeView[];
  metrics: { ts: number; equityUsd: number }[];
  config: unknown;
  persona: Persona | null;
  personaMods: AppliedMod[] | null;
}

/** CORE STATUS — diagnostics derived from real machine data, no fake health */
function CoreStatus({ detail }: { detail: Detail }) {
  const { bot, positions, trades, metrics } = detail;
  // capital: equity vs initial, capped at 100
  const capital = Math.max(0, Math.min(100, (bot.equityUsd / bot.initialBalanceUsd) * 100));
  // drawdown: peak-walk on the equity series
  let peak = 0;
  let dd = 0;
  for (const m of metrics) {
    peak = Math.max(peak, m.equityUsd);
    if (peak > 0) dd = Math.max(dd, ((peak - m.equityUsd) / peak) * 100);
  }
  // exposure: open position notional vs equity
  const posNotional = positions.reduce((s, p) => s + p.qty * p.markPrice, 0);
  const exposure = bot.equityUsd > 0 ? Math.min(100, (posNotional / bot.equityUsd) * 100) : 0;
  // trade frequency: last-24h trades vs a 20/day reference load
  const dayAgo = Date.now() - 86_400_000;
  const freq = Math.min(100, (trades.filter((t) => t.ts >= dayAgo).length / 20) * 100);

  const rows: { label: string; value: number; warn?: boolean; crit?: boolean }[] = [
    { label: 'Capital', value: capital, crit: capital < 70, warn: capital < 90 },
    { label: 'Drawdown', value: dd, crit: dd > 15, warn: dd > 7 },
    { label: 'Exposure', value: exposure, warn: exposure > 60 },
    { label: 'Trade load', value: freq },
  ];
  return (
    <Panel title="PAPER CORE STATUS" sub="arena diagnostics from simulated capital and real market data" noPad>
      <div className="panel-body">
        {rows.map((r) => (
          <div key={r.label} className="health-row">
            <span className="hlabel">{r.label}</span>
            <span className={`health-bar ${r.crit ? 'crit' : r.warn ? 'warn' : ''}`}>
              <span style={{ width: `${Math.max(2, r.value)}%` }} />
            </span>
            <span className="hval">{r.value.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function BotDetail() {
  usePageMeta('Machine', 'Machine dossier: strategy, positions, trade history and performance.');
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
  const live = bot.liveCapital;
  const isOwner = user && (user.isAdmin || bot.ownerName === user.displayName);
  const totalPnl = bot.equityUsd - bot.initialBalanceUsd;
  const totalPnlPct = (totalPnl / bot.initialBalanceUsd) * 100;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="dim" style={{ fontSize: 10, letterSpacing: 2 }}>
            ╔ MACHINE DOSSIER · {machineId(bot.id, bot.name)}
          </div>
          <h1 className="page-title row" style={{ gap: 12 }}>
            <span className="bot-avatar" style={{ fontSize: 26 }} aria-hidden="true">{machineAvatar(bot.id, bot.name)}</span>
            {bot.name}
            <span className={`chip ${live ? live.halted ? 'chip-stopped' : 'chip-running' : `chip-${bot.status}`}`}>
              {live ? live.halted ? '■ LIVE HALTED' : live.autonomyEnabled ? '● AUTONOMOUS' : '● MANUAL CANARY' : `● ${bot.status}`}
            </span>
            {bot.kind === 'house' && <span className="chip chip-house">house</span>}
          </h1>
          <div className="page-sub">
            CLASS: {CLASS_LABELS[bot.strategyType] ?? CLASS_LABELS.dsl}
            {bot.ownerName ? ` · OPERATOR: ${bot.ownerName}` : ' · property of the house'}
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

      {live && (
        <div className={`banner ${live.reconciliationStatus === 'clean' ? 'ok' : 'bad'}`} style={{ marginBottom: 12 }}>
          REAL CAPITAL // ROBINHOOD CHAIN {live.chainId} // {live.reconciliationStatus === 'clean' ? 'RECONCILED' : 'NOT RECONCILED'}
          {' '}// Manager allocation is the agent limit; the personal Rainbow wallet does not sign these trades.
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 14 }}>
        {live ? (
          <>
            <div className="stat-tile invert">
              <div className="label">Live agent capital</div>
              <div className="value">${fmtUsd(live.navUsd, 2)}</div>
              <div className="dim" style={{ fontSize: 11 }}>reconciled assets · reference marked</div>
            </div>
            <div className="stat-tile">
              <div className="label">Manager allocation</div>
              <div className="value">${fmtUsd(live.allocatedUsd, 2)} USDG</div>
            </div>
            <div className="stat-tile">
              <div className="label">Live USDG cash</div>
              <div className="value">${fmtUsd(live.cashUsd, 2)}</div>
            </div>
            <div className="stat-tile">
              <div className="label">Onchain exposure estimate</div>
              <div className="value">${fmtUsd(live.exposureUsd, 2)}</div>
              <div className="dim" style={{ fontSize: 11 }}>
                {(live.holdings.WETH ?? 0).toFixed(15)} WETH
              </div>
            </div>
            <div className={`stat-tile ${live.netPnlUsd > 0 ? 'pos' : live.netPnlUsd < 0 ? 'neg' : ''}`}>
              <div className="label">Live net P&amp;L</div>
              <div className="value">{live.netPnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(live.netPnlUsd), 2)}</div>
            </div>
            <div className="stat-tile">
              <div className="label">Confirmed live fills</div>
              <div className="value">{live.fillCount}</div>
            </div>
          </>
        ) : (
          <>
        <div className="stat-tile">
          <div className="label">Paper equity</div>
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
          <div className="label">Paper cash</div>
          <div className="value">${fmtUsd(bot.cashUsd, 0)}</div>
        </div>
          </>
        )}
      </div>

      {live && (
        <div className="panel-body" style={{ border: '1px solid var(--border)', marginBottom: 14 }}>
          <span className="soft">PAPER ARENA BOOK</span>{' '}
          <span className="dim">${fmtUsd(bot.equityUsd, 0)} simulated equity · ${fmtUsd(bot.initialBalanceUsd, 0)} simulated start · never live capital</span>
        </div>
      )}

      <CoreStatus detail={detail} />

      {isOwner && bot.kind === 'quant' && (
        <PersonaPanel
          botId={bot.id}
          persona={detail.persona}
          personaMods={detail.personaMods}
          onChanged={() => void load()}
        />
      )}

      <AgentPanel
        botId={bot.id}
        botName={bot.name}
        isDsl={bot.strategyType === 'dsl'}
        config={detail.config}
      />

      <Panel title="Paper equity curve" sub="simulated arena book; not the Trader wallet" noPad>
        <div style={{ padding: '12px 16px' }}>
          <Sparkline values={detail.metrics.map((m) => m.equityUsd)} height={90} />
        </div>
      </Panel>

      <Panel title="Paper positions" sub="simulation only" noPad>
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

      <Panel title="Paper decision log" sub="simulated trades; live execution is receipt-accounted separately" noPad>
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
          <button type="button" className="linkish" onClick={() => setShowJson(!showJson)}>
            {showJson ? 'hide' : 'show'}
          </button>
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
