import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LeaderboardRow } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { fmtUsd, fmtPct, pnlClass } from '../lib/format';

const WINDOWS = ['24h', '7d', 'all'] as const;

export function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [win, setWin] = useState<(typeof WINDOWS)[number]>('24h');

  const load = (w: string) =>
    api.get<{ rows: LeaderboardRow[] }>(`/api/leaderboard?window=${w}`).then((r) => setRows(r.rows));

  useEffect(() => {
    void load(win);
    const un =
      win === '24h' ? wsClient.sub('leaderboard', (d) => setRows(d as LeaderboardRow[])) : undefined;
    const t = setInterval(() => void load(win), 30_000);
    return () => {
      un?.();
      clearInterval(t);
    };
  }, [win]);

  return (
    <Panel
      title="LEADERBOARD // TOP TRADER CONTEST"
      right={
        <span className="tabs" style={{ borderBottom: 'none' }}>
          {WINDOWS.map((w) => (
            <button key={w} className={w === win ? 'active' : ''} onClick={() => setWin(w)}>
              {w}
            </button>
          ))}
        </span>
      }
      noPad
    >
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>bot</th>
            <th>owner</th>
            <th className="num">p&l %</th>
            <th className="num">p&l $</th>
            <th className="num">win rate</th>
            <th className="num">trades</th>
            <th className="num">max dd</th>
            <th className="num">age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.botId}>
              <td className={r.rank <= 3 ? 'amber' : 'dim'}>{r.rank}</td>
              <td>
                <Link to={`/bots/${r.botId}`}>{r.name}</Link>{' '}
                {r.kind === 'house' && <span className="amber">[HOUSE]</span>}
              </td>
              <td className="dim">{r.ownerName ?? 'punklabz'}</td>
              <td className={`num ${pnlClass(r.pnlPct)}`}>{fmtPct(r.pnlPct)}</td>
              <td className={`num ${pnlClass(r.pnlUsd)}`}>
                {r.pnlUsd >= 0 ? '+' : ''}{fmtUsd(r.pnlUsd)}
              </td>
              <td className="num">{r.winRate.toFixed(0)}%</td>
              <td className="num">{r.tradeCount}</td>
              <td className="num dim">{r.maxDrawdownPct.toFixed(1)}%</td>
              <td className="num dim">{r.ageDays < 1 ? '<1d' : `${r.ageDays.toFixed(0)}d`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
