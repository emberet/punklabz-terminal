import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { strategyConfigSchema, type StrategyConfig } from '@punklabz/shared';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { EquityChart } from '../components/EquityChart';
import { describeStrategy } from '../lib/dslText';
import { fmtUsd, fmtPct } from '../lib/format';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/pageMeta';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface BacktestRes {
  effectiveWindow: { fromTs: number; toTs: number; interval: string; bars: number; coveragePct: number };
  warnings: string[];
  initialBalanceUsd: number;
  finalEquityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  tradeCount: number;
  winRate: number;
  maxDrawdownPct: number;
  estimatedTradeTaxUsd: number;
  equityCurve: { ts: number; equityUsd: number }[];
  buyHold: { pnlPct: number; curve: { ts: number; equityUsd: number }[] };
}

const STYLES = [
  { label: 'Safe', prompt: 'I want a cautious bot: small positions, tight stop losses, few trades. ' },
  { label: 'Balanced', prompt: 'I want a balanced bot: moderate risk, steady trading. ' },
  { label: 'Aggressive', prompt: 'I want an aggressive bot: bigger positions, rides momentum hard. ' },
  { label: 'Degenerate', prompt: 'Max aggression within the allowed limits, fast trades, big swings. ' },
];

export function Build() {
  usePageMeta('Lab', 'Build and backtest a trading machine in plain language, then deploy it to the arena.');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<unknown | null>(null);
  const [draftValid, setDraftValid] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [earned, setEarned] = useState(0);
  const [notice, setNotice] = useState('');
  const [showJson, setShowJson] = useState(false);
  const [bt, setBt] = useState<BacktestRes | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const loadMoney = () => {
    void api.get<{ balanceUsd: number }>('/api/billing/balance').then((r) => setBalance(r.balanceUsd)).catch(() => {});
    void api
      .get<{ entries: { type: string; creditAccount: string; amountUsd: number }[] }>('/api/billing/ledger')
      .then((r) => {
        if (!user) return;
        setEarned(
          r.entries
            .filter((e) => e.type === 'fee_reuse' && e.creditAccount === `user:${user.id}`)
            .reduce((s, e) => s + e.amountUsd, 0),
        );
      })
      .catch(() => {});
  };

  useEffect(loadMoney, [user?.id]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, busy]);

  if (!user) {
    return (
      <div style={{ maxWidth: 700 }}>
        <div className="page-head">
          <div>
            <h1 className="page-title">Lab</h1>
            <div className="page-sub">BUILD // TEST // MUTATE // DEPLOY</div>
          </div>
        </div>
        <Panel title="MACHINE LABORATORY" term>
          <p>
            Tell the builder what you want in plain English — "buy bitcoin dips, sell at 5% profit" —
            and it becomes a paper bot competing in the arena. Backtest it first, deploy it for 20
            demo credits, and earn 10 demo credits every time someone clones it.
          </p>
          <p style={{ marginTop: 10 }}>
            <Link to="/login"><button className="primary">[ CONNECT TO BUILD ]</button></Link>
          </p>
        </Panel>
      </div>
    );
  }

  const parsedDraft: StrategyConfig | null = (() => {
    if (!draft || !draftValid) return null;
    const p = strategyConfigSchema.safeParse(draft);
    return p.success ? p.data : null;
  })();

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next: ChatMsg[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setNotice('');
    try {
      const turn = await api.post<{
        assistantText: string;
        draftConfig: unknown | null;
        valid: boolean;
        errors: string[];
      }>('/api/toolkit/chat', { messages: next });
      setMessages([...next, { role: 'assistant', content: turn.assistantText }]);
      if (turn.draftConfig) {
        setDraft(turn.draftConfig);
        setDraftValid(turn.valid);
        setErrors(turn.errors);
        setBt(null);
      }
    } catch (e: any) {
      setMessages([...next, { role: 'assistant', content: `[error] ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const backtest = async (window: string) => {
    if (!draft || btBusy) return;
    setBtBusy(true);
    setNotice('');
    try {
      setBt(await api.post<BacktestRes>('/api/toolkit/backtest', { config: draft, window }));
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBtBusy(false);
    }
  };

  const [deploying, setDeploying] = useState<'run' | 'done' | null>(null);

  const deploy = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice('');
    setDeploying('run');
    try {
      const res = await api.post<{ botId: number }>('/api/bots', { config: draft });
      loadMoney();
      setDeploying('done');
      setTimeout(() => navigate(`/bots/${res.botId}`), 1100);
    } catch (e: any) {
      setNotice(e.message);
      setDeploying(null);
      setBusy(false);
    }
  };

  const summary = parsedDraft ? describeStrategy(parsedDraft) : null;
  const afterDeploy = balance !== null ? balance - 20 : null;

  return (
    <div>
      {deploying && (
        <div className="cmdk-overlay">
          <div className="cmdk glitch-in">
            <div className="cmdk-head">machine deployment</div>
            <div className="syslog" style={{ padding: '12px 14px' }}>
              <span className="ln ok">[ OK ] INITIALIZING MACHINE…</span>
              <span className="ln ok">[ OK ] ALLOCATING CAPITAL…</span>
              <span className="ln ok">[ OK ] CONNECTING MARKET FEED…</span>
              {deploying === 'done' ? (
                <>
                  <span className="ln ok">[ OK ] STRATEGY LOADED · PARAMETERS VERIFIED</span>
                  <span className="ln phos" style={{ fontSize: 15 }}>MACHINE ONLINE.</span>
                </>
              ) : (
                <span className="ln cursor">LOADING STRATEGY…</span>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1 className="page-title">Lab</h1>
          <div className="page-sub">BUILD // TEST // MUTATE // DEPLOY — describe a machine, we synthesize it.</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Credits</div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font)' }} className="acid">
            ${balance === null ? '—' : fmtUsd(balance)}
          </div>
          {earned > 0 && <div className="soft" style={{ fontSize: 12 }}>+${fmtUsd(earned)} earned from your bots</div>}
        </div>
      </div>
      {notice && <div className="banner bad" style={{ marginBottom: 12, border: '1px solid var(--border)' }}>{notice}</div>}

      <div className="toolkit-layout">
        <Panel title="SYNTHESIS" sub="tell it what to trade" noPad>
          <div className="chat-log" ref={logRef}>
            {messages.length === 0 && (
              <>
                <div className="chat-msg assistant">
                  Describe the trading bot you want in plain English. Examples:{'\n\n'}
                  "buy bitcoin dips when it looks oversold, sell at 5% profit"{'\n'}
                  "ride SOL breakouts with strong volume"{'\n'}
                  "scalp ETH swings, small quick trades"
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 8, padding: '4px 0' }}>
                  {STYLES.map((s) => (
                    <button key={s.label} onClick={() => setInput(s.prompt)}>{s.label}</button>
                  ))}
                </div>
              </>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>{m.content}</div>
            ))}
            {busy && (
              <div className="syslog">
                <span className="ln ok">PARSING INTENT…</span>
                <span className="ln ok">BUILDING CONDITIONS…</span>
                <span className="ln cursor">VALIDATING DSL…</span>
              </div>
            )}
          </div>
          <div className="chat-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="describe your strategy…"
              disabled={busy}
            />
            <button className="primary" onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
          </div>
        </Panel>

        <div>
          <Panel title="STRATEGY BLUEPRINT" sub="what will be deployed" noPad>
            {summary ? (
              <>
                <div className={`banner ${draftValid ? 'ok' : 'bad'}`}>
                  {draftValid ? '✓ MACHINE CONFIGURATION GENERATED — READY' : `✗ INVALID: ${errors.join('; ')}`}
                </div>
                <div className="panel-body">
                  <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Market</div>
                  <div style={{ marginBottom: 10 }}>{summary.market}</div>
                  <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Entry</div>
                  <div style={{ marginBottom: 10 }}>
                    {summary.entry.map((l, i) => (
                      <div key={i}>
                        {l.joiner && <span className="acid" style={{ fontFamily: 'var(--font)', fontSize: 10, marginRight: 6 }}>{l.joiner}</span>}
                        {l.text}
                      </div>
                    ))}
                  </div>
                  <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Exit</div>
                  <div style={{ marginBottom: 10 }}>
                    {summary.exit.map((l, i) => (
                      <div key={i}>
                        {l.joiner && <span className="acid" style={{ fontFamily: 'var(--font)', fontSize: 10, marginRight: 6 }}>{l.joiner}</span>}
                        {l.text}
                      </div>
                    ))}
                  </div>
                  <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Risk</div>
                  <div style={{ marginBottom: 10 }}>{summary.risk.join(' · ')}</div>
                  <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Sizing</div>
                  <div>{summary.sizing}</div>
                </div>
                <div className="chat-input" style={{ borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  <span className="dim" style={{ alignSelf: 'center', fontSize: 11 }}>Backtest:</span>
                  {['24h', '7d', '30d', '90d'].map((w) => (
                    <button key={w} disabled={btBusy} onClick={() => backtest(w)}>{w}</button>
                  ))}
                  <span className="spacer" />
                  <button className="primary" disabled={!draftValid || busy} onClick={deploy}>
                    DEPLOY MACHINE · 20 CREDITS
                  </button>
                </div>
                {afterDeploy !== null && draftValid && (
                  <div className="panel-body dim" style={{ paddingTop: 0, fontSize: 12 }}>
                    You'll have ${fmtUsd(Math.max(0, afterDeploy))} left after deploying.
                    {afterDeploy < 0 && <span className="red"> Not enough credits.</span>}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setShowJson(!showJson)}
                  className="linkish dim"
                  aria-expanded={showJson}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 16px', fontFamily: 'var(--font)', fontSize: 10, letterSpacing: 1 }}
                >
                  CONFIG ▸ JSON {showJson ? '▲' : '▼'}
                </button>
                {showJson && <div className="config-preview">{JSON.stringify(draft, null, 2)}</div>}
              </>
            ) : (
              <div className="panel-body dim">No draft yet — talk to the builder.</div>
            )}
          </Panel>

          {btBusy && <Panel title="Backtest"><span className="dim">running…</span></Panel>}
          {bt && !btBusy && (
            <Panel title="Backtest result" sub="simulated on historical data — indicative only" noPad>
              <div className="panel-body">
                <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                  <span className={`pill ${bt.pnlPct >= 0 ? 'pill-pos' : 'pill-neg'}`} style={{ fontSize: 16, padding: '3px 10px' }}>
                    {bt.pnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(bt.pnlUsd))} ({fmtPct(bt.pnlPct)})
                  </span>
                  <span className="soft">{bt.winRate.toFixed(0)}% win rate</span>
                  <span className="soft">{bt.tradeCount} trades</span>
                  <span className="soft">max DD −{bt.maxDrawdownPct.toFixed(1)}%</span>
                  <span className="soft">vs BTC {fmtPct(bt.buyHold.pnlPct)}</span>
                </div>
                <EquityChart series={bt.equityCurve} benchmark={bt.buyHold.curve} />
                {bt.warnings.length > 0 && (
                  <div className="amber" style={{ marginTop: 8, fontSize: 12 }}>
                    {bt.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                  </div>
                )}
                <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
                  Demo-credit trade tax estimate: {fmtUsd(bt.estimatedTradeTaxUsd, 0)} credits.
                </div>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
