import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { BotSummary } from '@punklabz/shared';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { fmtUsd, fmtDate, pnlClass, fmtPct } from '../lib/format';
import { useAuth } from '../lib/auth';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface LedgerEntry {
  id: number;
  ts: number;
  type: string;
  amountUsd: number;
  debitAccount: string;
  creditAccount: string;
  memo: string;
}

export function Toolkit() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<unknown | null>(null);
  const [draftValid, setDraftValid] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [notice, setNotice] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  const loadMoney = () => {
    void api.get<{ balanceUsd: number }>('/api/billing/balance').then((r) => setBalance(r.balanceUsd)).catch(() => {});
    void api.get<{ entries: LedgerEntry[] }>('/api/billing/ledger').then((r) => setLedger(r.entries)).catch(() => {});
    void api.get<{ bots: BotSummary[] }>('/api/bots').then((r) => setBots(r.bots)).catch(() => {});
  };

  useEffect(loadMoney, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, busy]);

  if (!user) {
    return (
      <Panel title="TOOLKIT // BOT BUILDER">
        <p>
          The toolkit turns plain English into a live trading bot. No code, no charts, no jargon —
          describe the idea, the agent builds it, you deploy it for <span className="green">$20</span>.
        </p>
        <p style={{ marginTop: 8 }}>
          <Link to="/login">[ LOG IN TO BUILD ]</Link>
        </p>
      </Panel>
    );
  }

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMsg[] = [...messages, { role: 'user', content: text }];
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
      }
    } catch (e: any) {
      setMessages([...next, { role: 'assistant', content: `[error] ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const deploy = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice('');
    try {
      const res = await api.post<{ botId: number }>('/api/bots', { config: draft });
      loadMoney();
      navigate(`/bots/${res.botId}`);
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  };

  const clone = async (botId: number) => {
    setNotice('');
    try {
      const res = await api.post<{ botId: number }>(`/api/bots/${botId}/clone`);
      loadMoney();
      navigate(`/bots/${res.botId}`);
    } catch (e: any) {
      setNotice(e.message);
    }
  };

  const myBots = bots.filter((b) => b.kind === 'quant' && b.ownerName === user.displayName);
  const market = bots.filter((b) => b.kind === 'quant' && b.ownerName !== user.displayName);
  const cloneEarnings = ledger
    .filter((e) => e.type === 'fee_reuse' && e.creditAccount === `user:${user.id}`)
    .reduce((s, e) => s + e.amountUsd, 0);

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="dim">BALANCE</span>
        <span className="green">${balance === null ? '—' : fmtUsd(balance)}</span>
        <span className="dim">· deploy $20 · clone $10 · $1/trade tax</span>
        <span className="spacer" />
        {notice && <span className="red">{notice}</span>}
      </div>

      <div className="toolkit-layout">
        <Panel title="BUILDER AGENT // DESCRIBE YOUR STRATEGY" noPad>
          <div className="chat-log" ref={logRef}>
            {messages.length === 0 && (
              <div className="chat-msg assistant">
                Describe the trading bot you want in plain English. Examples:{'\n\n'}
                “buy bitcoin dips when it looks oversold, sell at 5% profit”{'\n'}
                “ride SOL breakouts with strong volume”{'\n'}
                “scalp ETH swings, small quick trades”{'\n\n'}
                I'll turn it into a strategy config you can deploy. No coding needed.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>{m.content}</div>
            ))}
            {busy && <div className="chat-msg assistant dim">thinking…</div>}
          </div>
          <div className="chat-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="describe your strategy…"
              disabled={busy}
            />
            <button onClick={send} disabled={busy || !input.trim()}>send</button>
          </div>
        </Panel>

        <Panel title="STRATEGY CONFIG // PREVIEW" noPad>
          {draft ? (
            <>
              <div className={`banner ${draftValid ? 'ok' : 'bad'}`}>
                {draftValid ? '✓ valid — ready to deploy' : `✗ invalid: ${errors.join('; ')}`}
              </div>
              <div className="config-preview">{JSON.stringify(draft, null, 2)}</div>
              <div className="chat-input">
                <button
                  className="primary"
                  disabled={!draftValid || busy}
                  onClick={deploy}
                >
                  deploy −$20
                </button>
              </div>
            </>
          ) : (
            <div className="panel-body dim">no draft yet — talk to the builder</div>
          )}
        </Panel>
      </div>

      <Panel title={`MY BOTS // CLONE EARNINGS +$${fmtUsd(cloneEarnings)}`} noPad>
        <table>
          <thead>
            <tr><th>bot</th><th className="num">equity</th><th className="num">24h</th><th>status</th></tr>
          </thead>
          <tbody>
            {myBots.length === 0 && <tr><td colSpan={4} className="dim">none yet</td></tr>}
            {myBots.map((b) => (
              <tr key={b.id}>
                <td><Link to={`/bots/${b.id}`}>{b.name}</Link></td>
                <td className="num">${fmtUsd(b.equityUsd)}</td>
                <td className={`num ${pnlClass(b.pnlPct24h)}`}>{fmtPct(b.pnlPct24h)}</td>
                <td className="dim">{b.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="CLONE MARKET // OTHER QUANTS' BOTS" noPad>
        <table>
          <thead>
            <tr><th>bot</th><th>owner</th><th className="num">24h</th><th></th></tr>
          </thead>
          <tbody>
            {market.length === 0 && <tr><td colSpan={4} className="dim">no public quant bots yet</td></tr>}
            {market.map((b) => (
              <tr key={b.id}>
                <td><Link to={`/bots/${b.id}`}>{b.name}</Link></td>
                <td className="dim">{b.ownerName}</td>
                <td className={`num ${pnlClass(b.pnlPct24h)}`}>{fmtPct(b.pnlPct24h)}</td>
                <td className="num"><button onClick={() => clone(b.id)}>clone −$10</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="LEDGER" noPad>
        <table>
          <thead>
            <tr><th>time</th><th>type</th><th className="num">amount</th><th>memo</th></tr>
          </thead>
          <tbody>
            {ledger.map((e) => {
              const incoming = e.creditAccount === `user:${user.id}`;
              return (
                <tr key={e.id}>
                  <td className="dim">{fmtDate(e.ts)}</td>
                  <td>{e.type}</td>
                  <td className={`num ${incoming ? 'pnl-pos' : 'pnl-neg'}`}>
                    {incoming ? '+' : '−'}${fmtUsd(e.amountUsd)}
                  </td>
                  <td className="dim">{e.memo}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
