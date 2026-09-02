import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotSummary } from '@punklabz/shared';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { arrow, fmtUsd, fmtPct, fmtDate, pillClass } from '../lib/format';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/pageMeta';

interface LedgerEntry {
  id: number;
  ts: number;
  type: string;
  amountUsd: number;
  debitAccount: string;
  creditAccount: string;
  memo: string;
}

export function MyBots() {
  usePageMeta('Botnet', 'Your machines: status, positions, P&L and controls.');
  const { user } = useAuth();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    void api.get<{ bots: BotSummary[] }>('/api/bots').then((r) => setBots(r.bots));
    void api.get<{ entries: LedgerEntry[] }>('/api/billing/ledger').then((r) => setLedger(r.entries)).catch(() => {});
    void api.get<{ balanceUsd: number }>('/api/billing/balance').then((r) => setBalance(r.balanceUsd)).catch(() => {});
  }, []);

  if (!user) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">Botnet</h1>
            <div className="page-sub">your machines</div>
          </div>
        </div>
        <Panel title="Botnet">
          <p><Link to="/login">Log in</Link> to see your bots.</p>
        </Panel>
      </div>
    );
  }

  const mine = bots.filter((b) => b.kind === 'quant' && b.ownerName === user.displayName);
  const earned = ledger
    .filter((e) => e.type === 'fee_reuse' && e.creditAccount === `user:${user.id}`)
    .reduce((s, e) => s + e.amountUsd, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Botnet</h1>
          <div className="page-sub">
            Demo credits {balance === null ? '—' : fmtUsd(balance)}
            {earned > 0 ? ` · +${fmtUsd(earned)} demo credits from clones of your bots` : ''}
          </div>
        </div>
        <Link to="/build"><button className="primary">[ NEW MACHINE ]</button></Link>
      </div>

      <Panel title="YOUR MACHINES" noPad>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>bot</th>
                <th className="num">live capital</th>
                <th className="num">24h</th>
                <th className="num">trades</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {mine.length === 0 && (
                <tr><td colSpan={5} className="dim">None yet — <Link to="/build">build your first bot</Link>.</td></tr>
              )}
              {mine.map((b) => (
                <tr key={b.id}>
                  <td><Link to={`/bots/${b.id}`}>{b.name}</Link></td>
                  <td className="num">
                    ${fmtUsd(b.liveCapital?.navUsd ?? 0, 2)}
                    {!b.liveCapital && <div className="dim" style={{ fontSize: 9 }}>NO LIVE WALLET</div>}
                  </td>
                  <td className="num">
                    <span className={`pill ${pillClass(b.pnlPct24h)}`}>{fmtPct(b.pnlPct24h)} {arrow(b.pnlPct24h)}</span>
                  </td>
                  <td className="num">{b.tradeCount}</td>
                  <td><span className="chip chip-paused">● PAPER {b.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Demo ledger" sub="credits only — no cash value" noPad>
        <div className="table-scroll">
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
                    <td className="soft">{e.type.replace('fee_', '').replace('_', ' ')}</td>
                    <td className="num">
                      <span className={`pill ${incoming ? 'pill-pos' : 'pill-neg'}`}>
                        {incoming ? '+' : '−'}{fmtUsd(e.amountUsd)} CR
                      </span>
                    </td>
                    <td className="dim">{e.memo}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
