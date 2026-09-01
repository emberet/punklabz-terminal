import { useEffect, useState } from 'react';
import type { LiveStatusView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from './Panel';
import { NumberTicker } from './motion/NumberTicker';
import { fmtUsd, fmtTime, shortAddr } from '../lib/format';
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
  operatorTest?: boolean;
  experimentRunId?: number | null;
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

interface CapitalControls {
  allocations: { botId: number; botName: string; allocatedUsdg: number; active: number }[];
  bots: { id: number; name: string; status: string }[];
  accounts: {
    id: number; name: string; role: string; walletAddress: string | null;
    holdings: Record<string, number>; fundingProof: { total: number; complete: boolean };
  }[];
}

interface AdvisorySession {
  id: number;
  topic: string;
  orderId: number;
  orderState: string;
  transcript: { speaker: string; text: string }[];
  turns: number;
  outcome: string;
  startedAt: number;
}

const NETWORK_MAP = `                [ PUNKLABZ ]
                     │
               [ RISK CORE ]
                     │
             [ ORDER ROUTER ]
                /           \\
            SHADOW     ROBINHOOD 4663
              │          │       │
          THEORETICAL   0x     PRIVY
                         │
                    WETH / USDG`;

export function LiveNetworkPanel() {
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const [status, setStatus] = useState<LiveStatusView | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [pfMode, setPfMode] = useState('live');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [capital, setCapital] = useState<CapitalControls>({ allocations: [], bots: [], accounts: [] });
  const [discussions, setDiscussions] = useState<AdvisorySession[]>([]);
  const [allocationBot, setAllocationBot] = useState('');
  const [allocationUsd, setAllocationUsd] = useState('0.50');

  const load = () => {
    void api.get<LiveStatusView>(isAdmin ? '/api/admin/live/status' : '/api/live/status').then(setStatus).catch(() => {});
    if (!isAdmin) return;
    void api.get<{ orders: LiveOrder[] }>('/api/admin/live/orders').then((r) => setOrders(r.orders)).catch(() => {});
    void api.get<{ venues: Venue[] }>('/api/admin/live/venues').then((r) => setVenues(r.venues)).catch(() => {});
    void api.get<Preflight>(`/api/admin/live/preflight?mode=${pfMode}`).then(setPreflight).catch(() => {});
    void api.get<CapitalControls>('/api/admin/live/accounts').then((r) => {
      setCapital(r);
      setAllocationBot((current) => current || String(r.bots[0]?.id ?? ''));
    }).catch(() => {});
    void api.get<{ sessions: AdvisorySession[] }>('/api/admin/live/discussions?limit=8')
      .then((r) => setDiscussions(r.sessions)).catch(() => {});
  };

  useEffect(() => {
    load();
    const un = wsClient.sub('live', () => load());
    const t = setInterval(load, 20_000);
    return () => {
      un();
      clearInterval(t);
    };
  }, [pfMode, isAdmin]);

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
  const phase = status.phase ?? status.mode ?? 'shadow';
  const phaseLabel = phase === 'canary_probe'
    ? 'CANARY PROBE'
    : phase === 'autonomous_canary'
      ? 'AUTONOMOUS CANARY'
      : phase.toUpperCase();
  const sponsor = capital.bots.find((bot) => bot.name === 'MOMENTUM RUNNER');
  return (
    <>
      <Panel
        title="EXECUTION NETWORK"
        sub="Robinhood Chain mainnet — USDG trading cash, ETH gas, WETH/USDG execution"
        noPad
        right={
          <span className={`chip ${status.halted ? 'chip-stopped' : status.mode === 'simulation' ? 'chip-paused' : 'chip-running'}`}>
            {status.halted ? '■ HALTED' : `● ${phaseLabel}`}
          </span>
        }
      >
        <div className="panel-body">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 12 }}>
            <div className="stat-tile invert">
              <div className="label">Stage capital</div>
              <div className="value">${fmtUsd(status.stageCapUsd, 0)}</div>
            </div>
            {isAdmin && <div className="stat-tile">
              <div className="label">Wallet NAV</div>
              <div className="value">$<NumberTicker value={status.nav.totalUsd} format={(n) => n.toFixed(2)} /></div>
            </div>}
            {isAdmin && status.experiment && <div className="stat-tile">
              <div className="label">Probe round trip</div>
              <div className="value">{status.experiment.state.replaceAll('_', ' ').toUpperCase()}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">USDG cash</div>
              <div className="value">${fmtUsd(status.settlementBalance ?? 0)}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">ETH gas</div>
              <div className="value">{(status.ethGasBalance ?? 0).toFixed(5)}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">WETH exposure</div>
              <div className="value">{(status.baseAssetBalance ?? 0).toFixed(6)}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">Pending tx</div>
              <div className="value">{status.pendingTransactions ?? 0}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">Clean fills</div>
              <div className="value">{status.promotion?.cleanFills ?? 0} / 10</div>
            </div>}
            {isAdmin && <div className={`stat-tile ${status.promotion?.reconciliationClean ? 'pos' : 'neg'}`}>
              <div className="label">Reconciliation</div>
              <div className="value">{status.promotion?.reconciliationClean ? 'CLEAN' : 'BLOCKED'}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">Deployed</div>
              <div className="value">${fmtUsd(status.nav.deployedUsd)}</div>
            </div>}
            <div className={`stat-tile ${status.today.netPnlUsd > 0 ? 'pos' : status.today.netPnlUsd < 0 ? 'neg' : ''}`}>
              <div className="label">{isAdmin ? 'Today' : 'Delayed P&L'}</div>
              <div className="value">{status.today.netPnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(status.today.netPnlUsd))}</div>
            </div>
            {isAdmin && <div className={`stat-tile ${status.today.drawdownPct > 5 ? 'neg' : ''}`}>
              <div className="label">Drawdown</div>
              <div className="value">−{status.today.drawdownPct.toFixed(1)}%</div>
            </div>}
          </div>

          <div className="row" style={{ gap: 18, flexWrap: 'wrap', fontSize: 11 }} >
            <span className="dim">{isAdmin ? 'THROUGHPUT TODAY:' : 'DELAYED AGGREGATES:'}</span>
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
                onClick={() => act(() => api.post('/api/admin/live/mode', {
                  mode: status.halted ? 'shadow' : status.mode === 'shadow' ? 'simulation' : 'shadow',
                }))}
              >
                {status.halted ? 'RUN SHADOW' : status.mode === 'shadow' ? 'DISABLE SHADOW' : 'ENABLE SHADOW MODE'}
              </button>
              {status.capitalStage > 0 && status.capitalStage < 4 && (
                <button
                  disabled={busy}
                  onClick={() => act(() => api.post('/api/admin/live/stage', { stage: status.capitalStage + 1 }))}
                >
                  PROMOTE CAPITAL STAGE
                </button>
              )}
              {!status.halted ? (
                <button className="danger" disabled={busy} onClick={() => act(() => api.post('/api/admin/live/halt', { reason: 'operator halt' }))}>
                  ■ HALT LIVE NETWORK
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => {
                  const phrase = `ARM ROBINHOOD 4663 $${Math.max(5, status.stageCapUsd)}`;
                  const confirmation = window.prompt(`Type ${phrase}`);
                  if (confirmation) void act(() => api.post('/api/admin/live/arm', {
                    mode: status.mode === 'live' ? 'live' : 'canary',
                    stage: Math.max(1, status.capitalStage),
                    confirmation,
                  }));
                }}>
                  ARM MAINNET
                </button>
              )}
              {!status.halted && phase === 'canary_probe' && status.experiment?.state !== 'completed' && (
                <button className="primary" disabled={busy || !sponsor} onClick={() => {
                  const confirmation = window.prompt('Type RUN $0.50 ROUND TRIP');
                  if (confirmation) void act(() => api.post('/api/admin/live/probe/roundtrip', {
                    sponsorBotId: sponsor?.id,
                    idempotencyKey: `probe:${Date.now()}:${crypto.randomUUID()}`,
                    confirmation,
                  }));
                }}>
                  RUN $0.50 ROUND TRIP
                </button>
              )}
              {!status.halted && phase === 'canary_probe' && status.experiment?.state === 'completed' && (
                <button className="primary" disabled={busy} onClick={() => {
                  const confirmation = window.prompt('Type ENABLE AUTONOMOUS CANARY $5');
                  if (confirmation) void act(() => api.post('/api/admin/live/canary/enable', { confirmation }));
                }}>
                  ENABLE $5 AUTONOMY
                </button>
              )}
              <button disabled={busy} onClick={() => void act(() => api.post('/api/admin/live/reconcile'))}>
                RUN RECONCILIATION
              </button>
              <button disabled={busy} onClick={() => {
                const txHash = window.prompt('Robinhood Chain funding transaction hash');
                if (txHash) void act(() => api.post('/api/admin/live/funding/import', { txHash }));
              }}>
                IMPORT FUNDING TX
              </button>
              <span className="dim" style={{ fontSize: 10 }}>
                Canary/live opens only after recovery, reconciliation, and preflight. Composite score gate {status.limits?.confidenceThreshold ?? 90}/100; this is not a win probability.
              </span>
            </div>
          )}
        </div>
      </Panel>

      {isAdmin && (
        <Panel title="CUSTODY ISOLATION" sub="Manager funds Trader; only Trader reaches execution" noPad>
          <div className="tape" style={{ maxHeight: 220 }}>
            {capital.accounts.filter((account) => account.role !== 'book').map((account) => (
              <div className="tape-row" key={account.id}>
                <span className={account.role === 'trader' ? 'phos' : 'cyan'}>{account.name}</span>
                <span className="soft">{account.role.replaceAll('_', ' ').toUpperCase()}</span>
                <span>{Number(account.holdings.USDG ?? 0).toFixed(6)} USDG</span>
                <span>{Number(account.holdings.ETH ?? 0).toFixed(6)} ETH</span>
                <span className="dim">{account.walletAddress ? shortAddr(account.walletAddress) : 'UNBOUND'}</span>
                <span className={account.fundingProof.complete ? 'phos' : 'red'}>
                  {account.fundingProof.complete ? `${account.fundingProof.total} PROOF` : 'UNPROVEN'}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {isAdmin && (
        <Panel title="MANAGER ALLOCATIONS" sub="bounded USDG authority per autonomous bot" noPad>
          <div className="panel-body">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <select value={allocationBot} onChange={(event) => setAllocationBot(event.target.value)}>
                {capital.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} [{bot.status}]</option>)}
              </select>
              <input
                type="number" min="0" max={status.authorizedCapitalUsd ?? status.stageCapUsd} step="0.10"
                value={allocationUsd} onChange={(event) => setAllocationUsd(event.target.value)}
                aria-label="USDG allocation"
              />
              <button
                className="primary"
                disabled={busy || !allocationBot || !Number.isFinite(Number(allocationUsd))}
                onClick={() => void act(() => api.post('/api/admin/live/allocations', {
                  botId: Number(allocationBot), allocatedUsdg: Number(allocationUsd),
                }))}
              >
                SET ALLOCATION
              </button>
              <span className="dim">AUTHORIZED ${fmtUsd(status.authorizedCapitalUsd ?? 0)}</span>
            </div>
            <div className="tape" style={{ maxHeight: 180 }}>
              {capital.allocations.length === 0 && <div className="tape-row dim">no live USDG allocations</div>}
              {capital.allocations.map((allocation) => (
                <div className="tape-row" key={allocation.botId}>
                  <span className="phos">{allocation.botName}</span>
                  <span className="mono">${fmtUsd(allocation.allocatedUsdg)} USDG</span>
                  <span className={allocation.active ? 'phos' : 'dim'}>{allocation.active ? 'ACTIVE' : 'OFF'}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {isAdmin && discussions.length > 0 && (
        <Panel title="ADVISORY HUDDLES" sub="linked to orders; no execution authority" noPad>
          {discussions.map((session) => (
            <div className="panel-body" key={session.id} style={{ borderTop: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span className="amber">ADVISORY</span>
                <span className="phos">ORDER #{session.orderId}</span>
                <span className="soft">{session.orderState?.toUpperCase()}</span>
                <span className="dim">{session.turns} TURNS</span>
              </div>
              {session.transcript.map((turn, index) => (
                <div key={index} style={{ marginTop: 5 }}>
                  <span className="cyan">{turn.speaker}:</span>{' '}
                  <span className="soft">{turn.text}</span>
                </div>
              ))}
            </div>
          ))}
        </Panel>
      )}

      {isAdmin && (
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
      )}

      <div className="grid" style={{ gridTemplateColumns: isAdmin ? '1fr 1fr' : '1fr', gap: 12, alignItems: 'start' }}>
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

        {isAdmin && <Panel title="ORDER PIPELINE" sub="every intent, every verdict" noPad>
          <div className="tape" style={{ maxHeight: 300 }}>
            {orders.length === 0 && <div className="tape-row dim">no execution orders recorded</div>}
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
                  {o.operatorTest && <span className="amber">OPERATOR TEST</span>}
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
        </Panel>}
      </div>
    </>
  );
}
