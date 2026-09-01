import { useEffect, useState } from 'react';
import type { LiveStatusView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from './Panel';
import { NumberTicker } from './motion/NumberTicker';
import { fmtUsd, fmtTime, shortAddr } from '../lib/format';
import { useAuth } from '../lib/auth';
import { personalSign } from '../lib/wallet';

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
  risk: { checks?: { name: string; pass: boolean; detail: string }[] } | null;
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

interface ConfirmationRequest {
  title: string;
  prompt: string;
  expected?: string;
  submit: (value: string) => Promise<unknown>;
}

interface FullMarketReadiness {
  ready: boolean;
  blockers: string[];
  snapshotHash: string | null;
  pairCount: number;
  authorizedCapitalUsdg: number | null;
}

interface UniverseAdmin {
  active: {
    id: number; contentHash: string; assetCount: number; directedPairCount: number;
    policyHash: string | null; policyIds: string[];
  } | null;
  snapshots: { id: number; state: string; content_hash: string; created_at: number }[];
}

interface SweepAdmin {
  sweeps: { id: number; state: string; expected_pairs: number; completed_at: number | null; error: string | null }[];
}

const NETWORK_MAP = `                [ PUNKLABZ ]
                     │
              [ AGENT COUNCIL ]
                     │
               [ RISK CORE ]
                     │
             [ 38,220 ROUTES ]
                /           \\
            SHADOW     ROBINHOOD 4663
              │          │       │
          THEORETICAL   0x     PRIVY POLICY
                         │
                 VERIFIED REGISTRY`;

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
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [confirmationValue, setConfirmationValue] = useState('');
  const [fullReadiness, setFullReadiness] = useState<FullMarketReadiness | null>(null);
  const [universe, setUniverse] = useState<UniverseAdmin>({ active: null, snapshots: [] });
  const [sweeps, setSweeps] = useState<SweepAdmin['sweeps']>([]);

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
    void api.get<FullMarketReadiness>('/api/admin/live/full-market/readiness').then(setFullReadiness).catch(() => {});
    void api.get<UniverseAdmin>('/api/admin/live/universe').then(setUniverse).catch(() => {});
    void api.get<SweepAdmin>('/api/admin/live/sweeps').then((r) => setSweeps(r.sweeps)).catch(() => {});
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

  const requestConfirmation = (request: ConfirmationRequest) => {
    setConfirmationValue('');
    setConfirmation(request);
  };

  const submitConfirmation = () => {
    if (!confirmation) return;
    const value = confirmationValue.trim();
    if (!value) return;
    if (confirmation.expected && value !== confirmation.expected) {
      setNotice(`Confirmation must equal: ${confirmation.expected}`);
      return;
    }
    const submit = confirmation.submit;
    setConfirmation(null);
    setConfirmationValue('');
    void act(() => submit(value));
  };

  const attestJurisdiction = () => act(async () => {
    if (!user?.walletAddress) throw new Error('operator account has no wallet');
    const challenge = await api.get<{ timestamp: number; message: string }>('/api/admin/live/jurisdiction/message');
    const signature = await personalSign(challenge.message, user.walletAddress);
    await api.post('/api/admin/live/jurisdiction/attest', { timestamp: challenge.timestamp, signature });
  });

  const generatePolicy = async (value: string) => {
    const response = await api.post<{ bundle: unknown }>('/api/admin/live/universe/policy/generate', { confirmation: value });
    const blob = new Blob([JSON.stringify(response.bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `punklabz-universe-policy-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    return response;
  };

  if (!status) return null;
  const phase = status.phase ?? status.mode ?? 'shadow';
  const phaseLabel = status.halted || !status.autonomyEnabled
    ? phase === 'canary_probe' ? 'CANARY MANUAL' : phase.toUpperCase()
    : status.fullMarket?.enabled
      ? 'AUTONOMY ON'
      : phase === 'canary_probe'
    ? 'CANARY PROBE'
    : phase === 'autonomous_canary'
      ? 'AUTONOMOUS CANARY'
      : phase.toUpperCase();
  const sponsor = capital.bots.find((bot) => bot.name === 'MOMENTUM RUNNER');
  return (
    <>
      <Panel
        title="EXECUTION NETWORK"
        sub="Robinhood Chain mainnet — verified registry routing, USDG cash, ETH gas"
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
            {isAdmin && <div className="stat-tile">
              <div className="label">Verified assets</div>
              <div className="value">{status.fullMarket?.assetCount ?? 0}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">Directed routes</div>
              <div className="value">{(status.fullMarket?.directedPairCount ?? 0).toLocaleString()}</div>
            </div>}
            {isAdmin && <div className={`stat-tile ${status.fullMarket?.sweepState === 'complete' ? 'pos' : 'neg'}`}>
              <div className="label">Pair sweep</div>
              <div className="value">{(status.fullMarket?.sweepState ?? 'OFFLINE').toUpperCase()}</div>
            </div>}
            {isAdmin && <div className={`stat-tile ${status.fullMarket?.policyReady ? 'pos' : 'neg'}`}>
              <div className="label">Signer policy</div>
              <div className="value">{status.fullMarket?.policyReady ? 'MATCHED' : 'BLOCKED'}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">Council spend</div>
              <div className="value">${(status.fullMarket?.councilSpentUsd ?? 0).toFixed(2)} / ${(status.fullMarket?.councilCapUsd ?? 50).toFixed(0)}</div>
            </div>}
            {isAdmin && <div className="stat-tile">
              <div className="label">Authorized USDG</div>
              <div className="value">{status.fullMarket?.authorizedCapitalUsdg == null ? 'NOT SET' : `$${status.fullMarket.authorizedCapitalUsdg.toFixed(2)}`}</div>
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
                  requestConfirmation({
                    title: 'ARM MAINNET',
                    prompt: phrase,
                    expected: phrase,
                    submit: (value) => api.post('/api/admin/live/arm', {
                      mode: status.mode === 'live' ? 'live' : 'canary',
                      stage: Math.max(1, status.capitalStage),
                      confirmation: value,
                    }),
                  });
                }}>
                  ARM MAINNET
                </button>
              )}
              {!status.halted && phase === 'canary_probe' && status.experiment?.state !== 'completed' && (
                <button className="primary" disabled={busy || !sponsor} onClick={() => {
                  const phrase = 'RUN $0.50 ROUND TRIP';
                  requestConfirmation({
                    title: 'EXECUTE OPERATOR PROBE',
                    prompt: phrase,
                    expected: phrase,
                    submit: (value) => api.post('/api/admin/live/probe/roundtrip', {
                      sponsorBotId: sponsor?.id,
                      idempotencyKey: `probe:${Date.now()}:${crypto.randomUUID()}`,
                      confirmation: value,
                    }),
                  });
                }}>
                  RUN $0.50 ROUND TRIP
                </button>
              )}
              {!status.halted && phase === 'canary_probe' && status.experiment?.state === 'completed' && (
                <button className="primary" disabled={busy} onClick={() => {
                  const phrase = 'ENABLE AUTONOMOUS CANARY $5';
                  requestConfirmation({
                    title: 'ENABLE AUTONOMOUS CANARY',
                    prompt: phrase,
                    expected: phrase,
                    submit: (value) => api.post('/api/admin/live/canary/enable', { confirmation: value }),
                  });
                }}>
                  ENABLE $5 AUTONOMY
                </button>
              )}
              <button disabled={busy} onClick={() => void act(() => api.post('/api/admin/live/reconcile'))}>
                RUN RECONCILIATION
              </button>
              <button disabled={busy} onClick={() => {
                requestConfirmation({
                  title: 'IMPORT FUNDING',
                  prompt: 'Robinhood Chain funding transaction hash',
                  submit: (value) => api.post('/api/admin/live/funding/import', { txHash: value }),
                });
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
        <Panel title="FULL-MARKET GATES" sub="snapshot-bound autonomy readiness" noPad>
          <div className={`banner ${fullReadiness?.ready ? 'ok' : 'bad'}`}>
            {fullReadiness?.ready ? 'FULL-MARKET CANARY READY' : `FULL-MARKET BLOCKED — ${fullReadiness?.blockers.length ?? 0} GATE(S)`}
          </div>
          <div className="panel-body">
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 10 }}>
              <div className="stat-tile"><div className="label">Snapshot</div><div className="value">{universe.active ? `#${universe.active.id}` : 'NONE'}</div></div>
              <div className="stat-tile"><div className="label">Assets</div><div className="value">{universe.active?.assetCount ?? 0}</div></div>
              <div className="stat-tile"><div className="label">Routes</div><div className="value">{(universe.active?.directedPairCount ?? 0).toLocaleString()}</div></div>
              <div className="stat-tile"><div className="label">Latest sweep</div><div className="value">{(sweeps[0]?.state ?? 'NONE').toUpperCase()}</div></div>
            </div>
            {fullReadiness && !fullReadiness.ready && (
              <div className="syslog" style={{ marginBottom: 10 }}>
                {fullReadiness.blockers.map((blocker, index) => <div className="red" key={index}>[BLOCK] {blocker}</div>)}
              </div>
            )}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => void act(() => api.post('/api/admin/live/universe/snapshot'))}>CAPTURE SNAPSHOT</button>
              {universe.snapshots.some((snapshot) => snapshot.state === 'draft') && (
                <button disabled={busy} onClick={() => {
                  const draft = universe.snapshots.find((snapshot) => snapshot.state === 'draft')!;
                  const phrase = 'ACTIVATE VERIFIED UNIVERSE';
                  requestConfirmation({ title: `ACTIVATE SNAPSHOT #${draft.id}`, prompt: phrase, expected: phrase,
                    submit: (value) => api.post('/api/admin/live/universe/activate', { snapshotId: draft.id, confirmation: value }) });
                }}>ACTIVATE SNAPSHOT</button>
              )}
              <button disabled={busy || !user?.walletAddress} onClick={() => void attestJurisdiction()}>SIGN JURISDICTION ATTESTATION</button>
              {universe.active && (
                <button disabled={busy} onClick={() => {
                  const phrase = 'GENERATE SNAPSHOT POLICY';
                  requestConfirmation({ title: 'GENERATE PRIVY POLICY', prompt: phrase, expected: phrase, submit: generatePolicy });
                }}>GENERATE POLICY JSON</button>
              )}
              {universe.active?.policyHash && (
                <button disabled={busy} onClick={() => requestConfirmation({
                  title: 'CONFIRM PRIVY POLICY IDS', prompt: 'Comma-separated policy IDs observed on the runtime signer',
                  submit: (value) => api.post('/api/admin/live/universe/policy/confirm', {
                    policyHash: universe.active!.policyHash, policyIds: value.split(',').map((id) => id.trim()).filter(Boolean),
                  }),
                })}>CONFIRM PRIVY IDS</button>
              )}
              <button disabled={busy || !universe.active} onClick={() => void act(() => api.post('/api/admin/live/sweep'))}>RUN EXACT SWEEP</button>
              {sweeps.find((sweep) => sweep.state === 'complete') && (
                <button disabled={busy} onClick={() => void act(() => api.post('/api/admin/live/council/run', {
                  sweepId: sweeps.find((sweep) => sweep.state === 'complete')!.id,
                }))}>RUN AGENT COUNCIL</button>
              )}
              <button className="primary" disabled={busy || !fullReadiness?.ready} onClick={() => {
                const phrase = 'ENABLE AUTONOMOUS CANARY $5';
                requestConfirmation({ title: 'ENABLE FULL-MARKET CANARY', prompt: phrase, expected: phrase,
                  submit: (value) => api.post('/api/admin/live/full-market/enable', { confirmation: value }) });
              }}>ENABLE FULL-MARKET CANARY</button>
              {status.fullMarket?.enabled && (
                <button disabled={busy} onClick={() => {
                  const phrase = 'RUN AUTONOMOUS CYCLE';
                  requestConfirmation({ title: 'RUN AUTONOMOUS CYCLE', prompt: phrase, expected: phrase,
                    submit: (value) => api.post('/api/admin/live/full-market/cycle', { confirmation: value }) });
                }}>RUN ONE CYCLE</button>
              )}
            </div>
          </div>
        </Panel>
      )}

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
                {expanded === o.id && (
                  <div style={{ padding: '4px 14px 8px', fontSize: 10.5, background: 'var(--tint-hover)' }}>
                    {o.rejectReason && <div className="red">REJECTED: {o.rejectReason}</div>}
                    {(o.risk?.checks ?? []).map((c, i) => (
                      <div key={i}>
                        <span className={c.pass ? 'phos' : 'red'}>{c.pass ? '[ OK ]' : '[FAIL]'}</span>{' '}
                        <span className="dim">{c.name}</span> <span className="soft">{c.detail}</span>
                      </div>
                    ))}
                    {!o.rejectReason && !(o.risk?.checks?.length) && <div className="dim">NO DETERMINISTIC CHECK LOG ATTACHED</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>}
      </div>

      {confirmation && (
        <div className="live-confirm-backdrop" onMouseDown={() => setConfirmation(null)}>
          <form
            className="live-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              submitConfirmation();
            }}
          >
            <div className="live-confirm-heading">
              <span id="live-confirm-title">{confirmation.title}</span>
              <button type="button" aria-label="Close confirmation" onClick={() => setConfirmation(null)}>×</button>
            </div>
            <label htmlFor="live-confirm-input">{confirmation.expected ? 'TYPE EXACT PHRASE' : confirmation.prompt}</label>
            {confirmation.expected && <code>{confirmation.prompt}</code>}
            <input
              id="live-confirm-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={confirmationValue}
              onChange={(event) => setConfirmationValue(event.target.value)}
            />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setConfirmation(null)}>CANCEL</button>
              <button className="primary" type="submit" disabled={!confirmationValue.trim()}>CONFIRM</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
