import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from './Panel';
import { NumberTicker } from './motion/NumberTicker';
import { fmtTime } from '../lib/format';
import type { BotSummary } from '@punklabz/shared';

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

const MODELS = [
  { key: 'momentum', label: 'MOMENTUM' },
  { key: 'mean_reversion', label: 'MEAN REV' },
  { key: 'volatility', label: 'VOL EXPAND' },
  { key: 'launch', label: 'LAUNCH' },
  { key: 'herd', label: 'HERD' },
  { key: 'cross_chain_momentum', label: 'CROSS-CHAIN' },
] as const;

const EDGE_W = 360;
const EDGE_H = 132;
const EDGE_PAD_X = 22;
const EDGE_PAD_Y = 14;

const pct = (bps: number) => `${bps >= 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(2)}%`;

export function GlobalProcess() {
  const [data, setData] = useState<ProcessData | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [capital, setCapital] = useState<{ stageCapUsd: number; capitalStage: number; nav: { reserveUsd: number } } | null>(null);
  const [capitalBots, setCapitalBots] = useState<BotSummary[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = () => {
    void api.get<ProcessData>('/api/live/process').then(setData).catch(() => {});
    void api.get<{ opportunities: Opportunity[] }>('/api/live/opportunities?limit=24')
      .then((r) => setOpps(r.opportunities)).catch(() => {});
    void api.get<any>('/api/live/status').then(setCapital).catch(() => {});
    void api.get<{ bots: BotSummary[] }>('/api/bots').then((r) => setCapitalBots(r.bots)).catch(() => {});
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
  const activeAllocations = capitalBots
    .filter((bot) => bot.kind === 'house' && (bot.liveCapital?.allocatedUsd ?? 0) > 0)
    .sort((a, b) => (b.liveCapital?.allocatedUsd ?? 0) - (a.liveCapital?.allocatedUsd ?? 0));
  const stageCap = capital?.stageCapUsd ?? 0;
  const allocatedUsd = activeAllocations.reduce((sum, bot) => sum + (bot.liveCapital?.allocatedUsd ?? 0), 0);
  const unallocatedUsd = stageCap > 0 ? Math.max(0, stageCap - allocatedUsd) : (capital?.nav.reserveUsd ?? 0);
  const modelStats = MODELS.map((model) => {
    const rows = opps.filter((opportunity) => opportunity.scanner === model.key);
    const avgConfidence = rows.length
      ? rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length
      : 0;
    const avgEdge = rows.length
      ? rows.reduce((sum, row) => sum + row.edge.netEdgeBps, 0) / rows.length
      : 0;
    return { ...model, count: rows.length, avgConfidence, avgEdge };
  });
  const maxModelCount = Math.max(1, ...modelStats.map((model) => model.count));
  const edgeRange = Math.max(25, Math.min(400, ...opps.map((opportunity) => Math.abs(opportunity.edge.netEdgeBps))));
  const edgeX = (confidence: number) => EDGE_PAD_X + (Math.max(0, Math.min(100, confidence)) / 100) * (EDGE_W - EDGE_PAD_X * 2);
  const edgeY = (edgeBps: number) => {
    const clipped = Math.max(-edgeRange, Math.min(edgeRange, edgeBps));
    return EDGE_H / 2 - (clipped / edgeRange) * (EDGE_H / 2 - EDGE_PAD_Y);
  };

  return (
    <>
      <Panel title="CAPITAL CORE" sub="extreme capital efficiency mode" noPad>
        <div className="panel-body capital-core">
          <div className="capital-core-summary">
            <div>
              <div className="dim" style={{ fontSize: 9.5, letterSpacing: 1.5 }}>CANARY CAP</div>
              <div className="core-amount">${stageCap.toFixed(2)}</div>
              <div className="dim" style={{ fontSize: 10 }}>
                stage {capital?.capitalStage ?? 0} · unallocated ${unallocatedUsd.toFixed(2)}
              </div>
            </div>
            <div className="capital-mission">
              <div className="dim">MISSION</div>
              <div className="phos" style={{ fontSize: 13 }}>DO NOT TRADE MORE.</div>
              <div className="phos" style={{ fontSize: 13 }}>FIND BETTER TRADES.</div>
            </div>
            <div className="capital-core-stats">
              <div className="soft">MARKETS <span className="phos">{data.universeSize.toLocaleString()}</span></div>
              <div className="soft">SCANNERS <span className="phos">6</span></div>
              <div className="soft">PASSES/HR <span className="phos">{data.passesLastHour}</span></div>
              <div className="soft">PASS TIME <span className="phos">{data.avgPassMs}ms</span></div>
            </div>
          </div>
          <div className="capital-model">
            <div className="telemetry-head">
              <span>MANAGER ALLOCATION MODEL</span>
              <span className="dim">{activeAllocations.length} ACTIVE · ${allocatedUsd.toFixed(2)} BOUNDED</span>
            </div>
            <div className="capital-stack" aria-label="Manager allocation distribution">
              {activeAllocations.map((bot, index) => (
                <span
                  key={bot.id}
                  className={`capital-segment capital-segment-${index % 3}`}
                  style={{ width: `${stageCap > 0 ? ((bot.liveCapital?.allocatedUsd ?? 0) / stageCap) * 100 : 0}%` }}
                  title={`${bot.name}: $${(bot.liveCapital?.allocatedUsd ?? 0).toFixed(2)}`}
                />
              ))}
              <span className="capital-segment reserve" style={{ width: `${stageCap > 0 ? (unallocatedUsd / stageCap) * 100 : 100}%` }} />
            </div>
            <div className="capital-model-rows">
              {activeAllocations.map((bot, index) => (
                <div className="capital-model-row" key={bot.id}>
                  <span className={`capital-key capital-key-${index % 3}`} />
                  <span className="capital-agent">{bot.name}</span>
                  <span className={`capital-line capital-line-${index % 3}`}><span style={{ width: `${stageCap > 0 ? ((bot.liveCapital?.allocatedUsd ?? 0) / stageCap) * 100 : 0}%` }} /></span>
                  <span className="capital-usd">${(bot.liveCapital?.allocatedUsd ?? 0).toFixed(2)}</span>
                </div>
              ))}
              <div className="capital-model-row">
                <span className="capital-key reserve" />
                <span className="capital-agent">USDG RESERVE</span>
                <span className="capital-line reserve"><span style={{ width: `${stageCap > 0 ? (unallocatedUsd / stageCap) * 100 : 0}%` }} /></span>
                <span className="capital-usd">${unallocatedUsd.toFixed(2)}</span>
              </div>
            </div>
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
        <div className="panel-body process-grid">
          <div className="process-funnel">
            {STAGES.map((s) => {
              const value = data.funnel[s.key];
              // log scale: the funnel spans thousands to single digits
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
              <div className="soft process-quiet">
                NO QUALIFYING SETUPS. {data.funnel.candidates.toLocaleString()} candidates examined this hour;
                none cleared their entry conditions. The machines are watching, not trading.
              </div>
            )}
          </div>
          <div className="model-telemetry">
            <div className="edge-field">
              <div className="telemetry-head">
                <span>EDGE FIELD</span>
                <span className="dim">LATEST {opps.length}</span>
              </div>
              <svg viewBox={`0 0 ${EDGE_W} ${EDGE_H}`} role="img" aria-label="Opportunity confidence versus net edge">
                <line x1={EDGE_PAD_X} y1={EDGE_H / 2} x2={EDGE_W - EDGE_PAD_X} y2={EDGE_H / 2} className="edge-zero" />
                <line x1={edgeX(90)} y1={EDGE_PAD_Y} x2={edgeX(90)} y2={EDGE_H - EDGE_PAD_Y} className="edge-threshold" />
                {[25, 50, 75].map((confidence) => (
                  <line key={confidence} x1={edgeX(confidence)} y1={EDGE_PAD_Y} x2={edgeX(confidence)} y2={EDGE_H - EDGE_PAD_Y} className="edge-grid" />
                ))}
                {opps.map((opportunity) => (
                  <circle
                    key={opportunity.id}
                    cx={edgeX(opportunity.confidence)}
                    cy={edgeY(opportunity.edge.netEdgeBps)}
                    r={opportunity.state === 'high_confidence' ? 3.8 : 2.7}
                    className={opportunity.edge.netEdgeBps > 0 ? 'edge-point signal' : 'edge-point rejected'}
                  >
                    <title>{opportunity.scanner} · conf {opportunity.confidence} · net {pct(opportunity.edge.netEdgeBps)}</title>
                  </circle>
                ))}
                <text x={EDGE_PAD_X} y={11} className="edge-axis-label">+{(edgeRange / 100).toFixed(2)}%</text>
                <text x={EDGE_PAD_X} y={EDGE_H - 3} className="edge-axis-label">-{(edgeRange / 100).toFixed(2)}%</text>
                <text x={edgeX(90) + 4} y={11} className="edge-axis-label threshold">90 SCORE</text>
              </svg>
              <div className="edge-field-foot">
                <span>CONFIDENCE SCORE -&gt;</span>
                <span><b className="phos">●</b> POSITIVE EDGE <b className="red">●</b> REJECTED</span>
              </div>
            </div>
            <div className="model-array">
              <div className="telemetry-head">
                <span>MODEL ARRAY</span>
                <span className="dim">RECENT LOAD</span>
              </div>
              {modelStats.map((model) => (
                <div className="model-row" key={model.key}>
                  <span className="model-name">{model.label}</span>
                  <span className="model-load">
                    <span className={model.avgEdge > 0 ? 'positive' : ''} style={{ width: `${(model.count / maxModelCount) * 100}%` }} />
                  </span>
                  <span className="model-count">{String(model.count).padStart(2, '0')}</span>
                  <span className={model.avgEdge > 0 ? 'phos model-score' : 'red model-score'}>
                    {model.count ? `${Math.round(model.avgConfidence)} / ${pct(model.avgEdge)}` : '-- / --'}
                  </span>
                </div>
              ))}
            </div>
          </div>
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
