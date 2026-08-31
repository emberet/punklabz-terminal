import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotSummary } from '@punklabz/shared';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { arrow, fmtUsd, fmtPct, fmtDate, pillClass } from '../lib/format';
import { useAuth } from '../lib/auth';

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
      <Panel title="Botnet">
        <p><Link to="/login">Log in</Link> to see your bots.</p>
      </Panel>
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
          <div className="page-title">Botnet</div>
          <div className="page-sub">
            Credits ${balance === null ? '—' : fmtUsd(balance)}
            {earned > 0 ? ` · +$${fmtUsd(earned)} earned from clones of your bots` : ''}
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
                <th className="num">equity</th>
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
                  <td className="num">${fmtUsd(b.equityUsd, 0)}</td>
                  <td className="num">
                    <span className={`pill ${pillClass(b.pnlPct24h)}`}>{fmtPct(b.pnlPct24h)} {arrow(b.pnlPct24h)}</span>
                  </td>
                  <td className="num">{b.tradeCount}</td>
                  <td><span className={`chip chip-${b.status}`}>● {b.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Billing history" sub="mock ledger — demo credits only" noPad>
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
                        {incoming ? '+' : '−'}${fmtUsd(e.amountUsd)}
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
