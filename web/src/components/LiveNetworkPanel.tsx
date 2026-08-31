import { useEffect, useState } from 'react';
import type { LiveStatusView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from './Panel';
import { NumberTicker } from './motion/NumberTicker';
import { fmtUsd, fmtTime } from '../lib/format';
import { useAuth } from '../lib/auth';

interface LiveOrder {
  id: number;
  intentId: string;
  botId: number | null;
  instrumentId: string;
  venue: string;
  side: string;
  requestedUsd: number;
  approvedUsd: number | null;
  mode: string;
  state: string;
  confidence: number | null;
  risk: { checks: { name: string; pass: boolean; detail: string }[] } | null;
  expectedPrice: number | null;
  executedPrice: number | null;
  slippageBps: number | null;
  feeUsd: number;
  rejectReason: string | null;
  ts: number;
}

interface Venue {
  venue: string;
  status: string;
  note: string | null;
}

interface Preflight {
  targetMode: string;
  passed: boolean;
  lines: string[];
  blockers: string[];
}

const NETWORK_MAP = `                [ PUNKLABZ ]
                     │
               [ RISK CORE ]
                     │
             [ ORDER ROUTER ]
             /       |       \\
         SHADOW   EVM:BASE   SOLANA
            │        │          │
         (fills)   [stub]    [stub]
                     │
                 [ BROKER ]     [ POLYMARKET ]
                   [stub]          [stub]`;

export function LiveNetworkPanel() {
  const { user } = useAuth();
  const [status, setStatus] = useState<LiveStatusView | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [pfMode, setPfMode] = useState('live');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    void api.get<LiveStatusView>('/api/live/status').then(setStatus).catch(() => {});
    void api.get<{ orders: LiveOrder[] }>('/api/live/orders').then((r) => setOrders(r.orders)).catch(() => {});
    void api.get<{ venues: Venue[] }>('/api/live/venues').then((r) => setVenues(r.venues)).catch(() => {});
    void api.get<Preflight>(`/api/live/preflight?mode=${pfMode}`).then(setPreflight).catch(() => {});
  };

  useEffect(() => {
    load();
    const un = wsClient.sub('live', () => load());
    const t = setInterval(load, 20_000);
    return () => {
      un();
      clearInterval(t);
    };
  }, [pfMode]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      load();
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const isAdmin = !!user?.isAdmin;

  return (
    <>
      <Panel
        title="LIVE NETWORK"
        sub="execution safety spine — top mode in this build is SHADOW (nothing is ever submitted)"
        noPad
        right={
          <span className={`chip ${status.halted ? 'chip-stopped' : status.mode === 'simulation' ? 'chip-paused' : 'chip-running'}`}>
            {status.halted ? '■ HALTED' : `● ${status.mode.toUpperCase()}`}
          </span>
        }
      >
        <div className="panel-body">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 12 }}>
            <div className="stat-tile invert">
              <div className="label">Stage capital</div>
              <div className="value">${fmtUsd(status.stageCapUsd, 0)}</div>
            </div>
            <div className="stat-tile">
              <div className="label">NAV</div>
              <div className="value">$<NumberTicker value={status.nav.totalUsd} format={(n) => n.toFixed(2)} /></div>
            </div>
            <div className="stat-tile">
              <div className="label">Deployed</div>
              <div className="value">${fmtUsd(status.nav.deployedUsd)}</div>
            </div>
            <div className={`stat-tile ${status.today.netPnlUsd > 0 ? 'pos' : status.today.netPnlUsd < 0 ? 'neg' : ''}`}>
              <div className="label">Today</div>
              <div className="value">{status.today.netPnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(status.today.netPnlUsd))}</div>
            </div>
            <div className={`stat-tile ${status.today.drawdownPct > 5 ? 'neg' : ''}`}>
              <div className="label">Drawdown</div>
              <div className="value">−{status.today.drawdownPct.toFixed(1)}%</div>
            </div>
          </div>

          <div className="row" style={{ gap: 18, flexWrap: 'wrap', fontSize: 11 }} >
            <span className="dim">THROUGHPUT TODAY:</span>
            <span className="soft">WATCHED <b className="phos">{status.throughput.marketsWatched}</b></span>
            <span className="soft">SIGNALS <b className="phos">{status.throughput.signals}</b></span>
            <span className="soft">APPROVED <b className="phos">{status.throughput.approved}</b></span>
            <span className="soft">EXECUTED <b className="phos">{status.throughput.executed}</b></span>
            <span className="soft">REJECTED <b className="red">{status.throughput.rejected}</b></span>
          </div>

          {status.halted && (
            <div className="banner bad" style={{ marginTop: 10, border: '1px solid var(--red)' }}>
              NETWORK HALTED — {status.haltReason}
            </div>
          )}
          {notice && <div className="red" style={{ marginTop: 8, fontSize: 12 }}>{notice}</div>}

          {isAdmin && (
            <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
              <button
                className={status.mode === 'shadow' ? 'primary' : ''}
                disabled={busy}
                onClick={() => act(() => api.post('/api/live/mode', { mode: status.mode === 'shadow' ? 'simulation' : 'shadow' }))}
              >
                {status.mode === 'shadow' ? 'DISABLE SHADOW' : 'ENABLE SHADOW MODE'}
              </button>
              <button
                disabled={busy}
                onClick={() => act(() => api.post('/api/live/stage', { stage: status.capitalStage === 0 ? 1 : 0 }))}
              >
                STAGE: {status.capitalStage} (${status.stageCapUsd}) → {status.capitalStage === 0 ? '1 ($5)' : '0 ($0)'}
              </button>
              {!status.halted ? (
                <button className="danger" disabled={busy} onClick={() => act(() => api.post('/api/live/halt', { reason: 'operator halt' }))}>
                  ■ HALT LIVE NETWORK
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => act(() => api.post('/api/live/resume'))}>
                  RESUME NETWORK
                </button>
              )}
              <span className="dim" style={{ fontSize: 10 }}>
                Canary/live open only when preflight passes — {preflight?.blockers.length ?? '…'} prerequisite(s) missing today. Confidence gate {status.limits.confidenceThreshold}/100.
              </span>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="LIVE PREFLIGHT"
        sub="the gate is evidence, not an assertion — every prerequisite is checked"
        noPad
        right={
          <span className="tabs" style={{ display: 'inline-flex' }}>
            {['shadow', 'canary', 'live'].map((m) => (
              <button key={m} className={m === pfMode ? 'active' : ''} onClick={() => setPfMode(m)}>{m}</button>
            ))}
          </span>
        }
      >
        {preflight && (
          <>
            <div className={`banner ${preflight.passed ? 'ok' : 'bad'}`}>
              {preflight.passed
                ? `✓ ${preflight.targetMode.toUpperCase()} PREREQUISITES MET`
                : `✗ ${preflight.targetMode.toUpperCase()} BLOCKED — ${preflight.blockers.length} PREREQUISITE(S) MISSING`}
            </div>
            <div className="syslog" style={{ whiteSpace: 'pre-wrap' }}>
              {preflight.lines.map((l, i) => {
                const verdict = l.includes(' PASS ') ? 'phos' : l.includes(' WARN ') ? 'amber' : 'red';
                return <div key={i} className={verdict}>{l}</div>;
              })}
            </div>
          </>
        )}
      </Panel>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
        <Panel title="NETWORK MAP" term noPad>
          <pre className="ascii-art" style={{ padding: '10px 14px', color: 'var(--text-soft)' }}>{NETWORK_MAP}</pre>
          <div className="panel-body" style={{ paddingTop: 0 }}>
            {venues.map((v) => (
              <div key={v.venue} className="row" style={{ gap: 10, fontSize: 11, marginBottom: 3 }}>
                <span className={v.status === 'online' ? 'phos' : v.status === 'degraded' ? 'amber' : 'red'}>
                  ● {v.venue.toUpperCase()}
                </span>
                <span className="dim">{v.status}</span>
                {v.note && <span className="dim" style={{ fontSize: 10 }}>— {v.note}</span>}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="ORDER PIPELINE" sub="every intent, every verdict" noPad>
          <div className="tape" style={{ maxHeight: 300 }}>
            {orders.length === 0 && <div className="tape-row dim">no live-pipeline orders yet — enable shadow mode</div>}
            {orders.map((o) => (
              <div key={o.id}>
                <div
                  className="tape-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                >
                  <span className="t">{fmtTime(o.ts)}</span>
                  <span className={o.side === 'buy' ? 'side-buy' : 'side-sell'}>{o.side.toUpperCase()}</span>
                  <span>{o.instrumentId.split('/').pop()}</span>
                  <span className="dim">${o.approvedUsd?.toFixed(2) ?? o.requestedUsd.toFixed(2)}</span>
                  <span className={
                    o.state === 'filled' ? 'phos' : o.state === 'risk_rejected' || o.state === 'failed' ? 'red' : 'soft'
                  }>
                    {o.state.toUpperCase()}
                  </span>
                  {o.confidence !== null && <span className="dim">conf {o.confidence}</span>}
                  {o.slippageBps !== null && <span className="dim">slip {o.slippageBps.toFixed(1)}bp</span>}
                </div>
                {expanded === o.id && o.risk && (
                  <div style={{ padding: '4px 14px 8px', fontSize: 10.5, background: 'var(--tint-hover)' }}>
                    {o.rejectReason && <div className="red">REJECTED: {o.rejectReason}</div>}
                    {o.risk.checks.map((c, i) => (
                      <div key={i}>
                        <span className={c.pass ? 'phos' : 'red'}>{c.pass ? '[ OK ]' : '[FAIL]'}</span>{' '}
                        <span className="dim">{c.name}</span> <span className="soft">{c.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
