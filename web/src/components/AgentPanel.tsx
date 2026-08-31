import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Panel } from './Panel';
import { EquityChart } from './EquityChart';
import { fmtUsd, fmtPct } from '../lib/format';
import { useAuth } from '../lib/auth';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface RrRes {
  samples: number;
  wins: number;
  losses: number;
  timeouts: number;
  pWin: number;
  rrRatio: number;
  expectancyPct: number;
  leverage: number;
  leveragedGainPct: number;
  leveragedLossPct: number;
  leveragedExpectancyPct: number;
  liquidationStopPct: number;
}

interface BtRes {
  pnlUsd: number;
  pnlPct: number;
  tradeCount: number;
  winRate: number;
  maxDrawdownPct: number;
  warnings: string[];
  equityCurve: { ts: number; equityUsd: number }[];
  buyHold: { pnlPct: number; curve: { ts: number; equityUsd: number }[] };
}

export function AgentPanel({
  botId,
  botName,
  isDsl,
  config,
}: {
  botId: number;
  botName: string;
  isDsl: boolean;
  config: unknown;
}) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [playground, setPlayground] = useState(false);

  // playground state
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [stopPct, setStopPct] = useState(2);
  const [targetPct, setTargetPct] = useState(4);
  const [leverage, setLeverage] = useState(3);
  const [rr, setRr] = useState<RrRes | null>(null);
  const [rrErr, setRrErr] = useState('');
  const [bt, setBt] = useState<BtRes | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, busy]);

  // live RR recompute, debounced on every knob change
  useEffect(() => {
    if (!playground) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api
        .get<RrRes>(`/api/bots/${botId}/rr?symbol=${symbol}&stopPct=${stopPct}&targetPct=${targetPct}&leverage=${leverage}`)
        .then((r) => {
          setRr(r);
          setRrErr('');
        })
        .catch((e) => setRrErr(e.message));
    }, 250);
    return () => clearTimeout(debounce.current);
  }, [playground, symbol, stopPct, targetPct, leverage, botId]);

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    const next: ChatMsg[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const res = await api.post<{ reply: string }>(`/api/bots/${botId}/chat`, { messages: next });
      setMessages([...next, { role: 'assistant', content: res.reply }]);
    } catch (e: any) {
      setMessages([...next, { role: 'assistant', content: `[offline] ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const backtest = async (window: string) => {
    if (btBusy) return;
    setBtBusy(true);
    try {
      setBt(await api.post<BtRes>('/api/toolkit/backtest', { config, window }));
    } catch (e: any) {
      setRrErr(e.message);
    } finally {
      setBtBusy(false);
    }
  };

  return (
    <Panel
      title={`Talk to ${botName}`}
      sub="ask why it's watching what it's watching"
      noPad
      right={
        <button className={playground ? 'primary' : ''} onClick={() => setPlayground(!playground)}>
          Playground {playground ? '▲' : '▼'}
        </button>
      }
    >
      {playground && (
        <div className="playground">
          <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
            <label className="pg-field">
              <span>pair</span>
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                <option>BTCUSDT</option>
                <option>ETHUSDT</option>
                <option>SOLUSDT</option>
              </select>
            </label>
            <label className="pg-field">
              <span>stop %</span>
              <input type="number" min={0.1} max={50} step={0.5} value={stopPct}
                onChange={(e) => setStopPct(Number(e.target.value) || 0.5)} style={{ width: 70 }} />
            </label>
            <label className="pg-field">
              <span>target %</span>
              <input type="number" min={0.1} max={200} step={0.5} value={targetPct}
                onChange={(e) => setTargetPct(Number(e.target.value) || 0.5)} style={{ width: 70 }} />
            </label>
            <label className="pg-field" style={{ minWidth: 160 }}>
              <span>leverage {leverage}x</span>
              <input type="range" min={1} max={25} value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))} />
            </label>
          </div>

          {rrErr && <div className="red" style={{ marginTop: 8, fontSize: 12 }}>{rrErr}</div>}
          {rr && !rrErr && (
            <div style={{ marginTop: 10 }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                <span className={`pill ${rr.pWin >= 0.5 ? 'pill-pos' : 'pill-neg'}`} style={{ fontSize: 15, padding: '2px 10px' }}>
                  {(rr.pWin * 100).toFixed(1)}% hit target first
                </span>
                <span className="soft">RR 1:{rr.rrRatio.toFixed(2)}</span>
                <span className={rr.expectancyPct >= 0 ? 'acid' : 'red'}>
                  EV {rr.expectancyPct >= 0 ? '+' : ''}{rr.expectancyPct.toFixed(2)}%/trade
                </span>
                <span className="dim">{rr.samples} samples · {rr.timeouts} unresolved</span>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 6, fontSize: 12 }}>
                <span className="soft">at {rr.leverage}x:</span>
                <span className="acid">win +{rr.leveragedGainPct.toFixed(1)}% equity</span>
                <span className="red">loss −{rr.leveragedLossPct.toFixed(1)}% equity</span>
                <span className={rr.leveragedExpectancyPct >= 0 ? 'acid' : 'red'}>
                  EV {rr.leveragedExpectancyPct >= 0 ? '+' : ''}{rr.leveragedExpectancyPct.toFixed(2)}%
                </span>
                <span className="amber">liq at −{rr.liquidationStopPct.toFixed(1)}% move</span>
              </div>
              <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
                Empirical odds from the last 7 days of 1m candles — history, not prophecy. Paper trading only.
              </div>
            </div>
          )}

          {isDsl && (
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <span className="dim" style={{ fontSize: 11 }}>Live backtest this bot:</span>
              {['24h', '7d'].map((w) => (
                <button key={w} disabled={btBusy || !user} onClick={() => backtest(w)}>{w}</button>
              ))}
              {!user && <Link to="/login" className="dim" style={{ fontSize: 11 }}>log in to backtest</Link>}
              {btBusy && <span className="dim">running…</span>}
            </div>
          )}
          {bt && !btBusy && (
            <div style={{ marginTop: 10 }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                <span className={`pill ${bt.pnlPct >= 0 ? 'pill-pos' : 'pill-neg'}`}>
                  {bt.pnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(bt.pnlUsd))} ({fmtPct(bt.pnlPct)})
                </span>
                <span className="soft">{bt.winRate.toFixed(0)}% wr · {bt.tradeCount} trades · DD −{bt.maxDrawdownPct.toFixed(1)}%</span>
              </div>
              <EquityChart series={bt.equityCurve} benchmark={bt.buyHold.curve} height={90} />
            </div>
          )}
        </div>
      )}

      <div className="chat-log" ref={logRef} style={{ height: 260 }}>
        {messages.length === 0 && (
          <div className="chat-msg assistant">
            Ask me anything: what I'm watching right now and why, my read on buying or selling a
            pair, how I'd size it, or what X leverage would do to the math. Open the Playground to
            run the numbers yourself.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="chat-msg assistant dim">reading the tape…</div>}
      </div>
      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={user ? `ask ${botName.toLowerCase()}…` : 'log in to talk to the agent'}
          disabled={busy || !user}
        />
        <button className="primary" onClick={send} disabled={busy || !user || !input.trim()}>Ask</button>
      </div>
    </Panel>
  );
}
