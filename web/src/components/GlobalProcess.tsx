import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from './Panel';
import { NumberTicker } from './motion/NumberTicker';
import { fmtTime } from '../lib/format';

interface ProcessData {
  lastPass: { ts: number; durationMs: number; marketsObserved: number; scansPerformed: number } | null;
  funnel: {
    marketsObserved: number;
    candidates: number;
    signals: number;
    highConfidence: number;
    riskApproved: number;
    routed: number;
    executed: number;
    rejectedOnEdge: number;
  };
  passesLastHour: number;
  avgPassMs: number;
  universeSize: number;
  note: string;
}

interface Opportunity {
  id: number;
  ts: number;
  scanner: string;
  universe: string;
  symbol: string;
  direction: string;
  confidence: number;
  edge: {
    grossEdgeBps: number; feeBps: number; slippageBps: number;
    bufferBps: number; netEdgeBps: number; edgeModel: string;
  };
  evidence: Record<string, number | string>;
  state: string;
  rejectReason: string | null;
  advisory: boolean;
}

const STAGES: { key: keyof ProcessData['funnel']; label: string }[] = [
  { key: 'marketsObserved', label: 'MARKET OBSERVATIONS' },
  { key: 'candidates', label: 'CANDIDATES' },
  { key: 'signals', label: 'SIGNALS' },
  { key: 'highConfidence', label: 'HIGH CONFIDENCE' },
  { key: 'riskApproved', label: 'RISK APPROVED' },
  { key: 'routed', label: 'ROUTED' },
  { key: 'executed', label: 'EXECUTED' },
];

const pct = (bps: number) => `${bps >= 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(2)}%`;

export function GlobalProcess() {
  const [data, setData] = useState<ProcessData | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [capital, setCapital] = useState<{ stageCapUsd: number; capitalStage: number; nav: { reserveUsd: number } } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = () => {
    void api.get<ProcessData>('/api/live/process').then(setData).catch(() => {});
    void api.get<{ opportunities: Opportunity[] }>('/api/live/opportunities?limit=24')
      .then((r) => setOpps(r.opportunities)).catch(() => {});
    void api.get<any>('/api/live/status').then(setCapital).catch(() => {});
  };

  useEffect(() => {
    load();
    const un = wsClient.sub('process', () => load());
    const t = setInterval(load, 20_000);
    return () => {
      un();
      clearInterval(t);
    };
  }, []);

  if (!data) return null;
  const max = Math.max(1, data.funnel.marketsObserved);
  const quiet = data.funnel.signals === 0 && data.funnel.candidates > 0;

  return (
    <>
      <Panel title="CAPITAL CORE" sub="extreme capital efficiency mode" noPad>
        <div className="panel-body capital-core">
          <div>
            <div className="dim" style={{ fontSize: 9.5, letterSpacing: 1.5 }}>DEPLOYABLE</div>
            <div className="core-amount">${capital?.stageCapUsd.toFixed(2) ?? '0.00'}</div>
            <div className="dim" style={{ fontSize: 10 }}>
              stage {capital?.capitalStage ?? 0} · reserve ${capital?.nav.reserveUsd.toFixed(2) ?? '0.00'}
            </div>
          </div>
          <div className="capital-mission">
            <div className="dim">MISSION</div>
            <div className="phos" style={{ fontSize: 13 }}>DO NOT TRADE MORE.</div>
            <div className="phos" style={{ fontSize: 13 }}>FIND BETTER TRADES.</div>
          </div>
          <div style={{ fontSize: 11 }}>
            <div className="soft">MARKETS <span className="phos">{data.universeSize.toLocaleString()}</span></div>
            <div className="soft">SCANNERS <span className="phos">6</span></div>
            <div className="soft">PASSES/HR <span className="phos">{data.passesLastHour}</span></div>
            <div className="soft">PASS TIME <span className="phos">{data.avgPassMs}ms</span></div>
          </div>
        </div>
      </Panel>

      <Panel
        title="PUNKLABZ // GLOBAL PROCESS"
        sub="last hour · scan everything, trade selectively"
        noPad
        right={
          data.lastPass ? (
            <span className="dim" style={{ fontSize: 10 }}>
              LAST PASS {data.lastPass.durationMs}MS · {data.passesLastHour}/HR
            </span>
          ) : undefined
        }
      >
        <div className="panel-body">
          {STAGES.map((s) => {
            const value = data.funnel[s.key];
            // log scale: the funnel spans thousands → single digits
            const width = value > 0 ? Math.max(1.5, (Math.log10(value + 1) / Math.log10(max + 1)) * 100) : 0;
            return (
              <div key={s.key} className="funnel-row">
                <span className="funnel-label">{s.label}</span>
                <span className="funnel-value">
                  <NumberTicker value={value} />
                </span>
                <span className="funnel-bar">
                  <span style={{ width: `${width}%` }} />
                </span>
              </div>
            );
          })}
          <div className="row" style={{ marginTop: 10, gap: 16, flexWrap: 'wrap', fontSize: 11 }}>
            <span className="red">
              REJECTED ON NET EDGE <b><NumberTicker value={data.funnel.rejectedOnEdge} /></b>
            </span>
            <span className="dim">{data.note}</span>
          </div>
          {quiet && (
            <div className="soft" style={{ marginTop: 8, fontSize: 11, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              NO QUALIFYING SETUPS. {data.funnel.candidates.toLocaleString()} candidates examined this hour;
              none cleared their entry conditions. The machines are watching, not trading — this is the
              system working, not the system broken.
            </div>
          )}
        </div>
      </Panel>

      <Panel title="OPPORTUNITY STREAM" sub="every idea, and what it cost to reject it" noPad>
        <div className="tape" style={{ maxHeight: 340 }}>
          {opps.length === 0 && <div className="tape-row dim">scanners warming up…</div>}
          {opps.map((o) => {
            const dead = o.state === 'rejected';
            return (
              <div key={o.id}>
                <div
                  className="tape-row"
                  style={{ cursor: 'pointer', opacity: dead ? 0.72 : 1 }}
                  onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                >
                  <span className="t">{fmtTime(o.ts)}</span>
                  <span className={o.direction === 'buy' ? 'side-buy' : 'side-sell'}>
                    {o.direction.toUpperCase()}
                  </span>
                  <span>{o.symbol}</span>
                  <span className="dim">{o.scanner}</span>
                  <span className="dim">{o.universe}</span>
                  <span className={o.confidence >= 80 ? 'phos' : 'soft'}>conf {o.confidence}</span>
                  <span className={o.edge.netEdgeBps > 0 ? 'phos' : 'red'}>
                    net {pct(o.edge.netEdgeBps)}
                  </span>
                  <span className={dead ? 'red' : 'phos'}>
                    {dead ? '[ TERMINATED ]' : o.state === 'high_confidence' ? '[ HIGH CONF ]' : '[ SIGNAL ]'}
                  </span>
                </div>
                {expanded === o.id && (
                  <div className="edge-block">
                    <div>EXPECTED EDGE     <span className="phos">{pct(o.edge.grossEdgeBps)}</span></div>
                    <div>FEES              <span className="red">{pct(-o.edge.feeBps)}</span></div>
                    <div>SLIPPAGE          <span className="red">{pct(-o.edge.slippageBps)}</span></div>
                    <div>SAFETY BUFFER     <span className="red">{pct(-o.edge.bufferBps)}</span></div>
                    <div style={{ borderTop: '1px solid var(--border)', marginTop: 3, paddingTop: 3 }}>
                      NET EDGE          <span className={o.edge.netEdgeBps > 0 ? 'phos' : 'red'}>{pct(o.edge.netEdgeBps)}</span>
                    </div>
                    <div className="dim" style={{ marginTop: 5 }}>
                      model {o.edge.edgeModel} · evidence{' '}
                      {Object.entries(o.evidence).map(([k, v]) => `${k}=${v}`).join(' · ')}
                    </div>
                    {o.advisory && (
                      <div className="dim" style={{ marginTop: 3 }}>
                        advisory — scanner opportunity, no capital committed
                      </div>
                    )}
                    {dead && <div className="red" style={{ marginTop: 3 }}>SIGNAL TERMINATED ░▒▓ {o.rejectReason}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </>
  );
}
