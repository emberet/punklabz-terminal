import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LeaderboardRow } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { arrow, fmtUsd, fmtPct, pillClass } from '../lib/format';
import { useAuth } from '../lib/auth';

type Row = LeaderboardRow & { rankDelta24h?: number | null };

interface SeasonInfo {
  season: { id: number; name: string; endsAt: number };
  countdownMs: number;
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function Leaderboard() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [win, setWin] = useState<string>('24h');
  const [season, setSeason] = useState<SeasonInfo | null>(null);

  const windows = season ? ['24h', '7d', 'season', 'all'] : ['24h', '7d', 'all'];

  const load = (w: string) =>
    api.get<{ rows: Row[] }>(`/api/leaderboard?window=${w}`).then((r) => setRows(r.rows)).catch(() => {});

  useEffect(() => {
    void api.get<SeasonInfo>('/api/seasons/current').then(setSeason).catch(() => {});
  }, []);

  useEffect(() => {
    void load(win);
    const un = win === '24h' ? wsClient.sub('leaderboard', (d) => setRows(d as Row[])) : undefined;
    const t = setInterval(() => void load(win), 30_000);
    return () => {
      un?.();
      clearInterval(t);
    };
  }, [win]);

  const myBest = user ? rows.find((r) => r.ownerName === user.displayName) : undefined;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Leaderboard</div>
          <div className="page-sub">
            Every bot in the arena, ranked.
            {season && win === 'season' && (
              <span className="acid"> {season.season.name} — {Math.ceil(season.countdownMs / 86_400_000)} days left</span>
            )}
          </div>
        </div>
        <div className="tabs">
          {windows.map((w) => (
            <button key={w} className={w === win ? 'active' : ''} onClick={() => setWin(w)}>
              {w}
            </button>
          ))}
        </div>
      </div>

      {myBest && (
        <div className="stat-tile" style={{ marginBottom: 14, display: 'flex', gap: 24, alignItems: 'baseline' }}>
          <span className="label">You</span>
          <span className="value" style={{ fontSize: 18 }}>#{myBest.rank} · {myBest.name}</span>
          {myBest.rankDelta24h != null && myBest.rankDelta24h !== 0 && (
            <span className={`pill ${pillClass(myBest.rankDelta24h)}`}>
              {arrow(myBest.rankDelta24h)}{Math.abs(myBest.rankDelta24h)} today
            </span>
          )}
          <span className={`pill ${pillClass(myBest.pnlPct)}`}>{fmtPct(myBest.pnlPct)}</span>
        </div>
      )}

      <Panel title="Rankings" noPad>
        <div className="table-scroll">
          <table style={{ minWidth: 840 }}>
            <thead>
              <tr>
                <th>#</th>
                <th></th>
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
                  <td className={r.rank <= 3 ? 'amber' : 'dim'}>
                    {r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank}
                  </td>
                  <td>
                    {r.rankDelta24h != null && r.rankDelta24h !== 0 ? (
                      <span className={`rank-delta pill ${pillClass(r.rankDelta24h)}`}>
                        {arrow(r.rankDelta24h)}{Math.abs(r.rankDelta24h)}
                      </span>
                    ) : r.rankDelta24h === null ? (
                      <span className="rank-delta pill pill-neu">NEW</span>
                    ) : null}
                  </td>
                  <td>
                    <Link to={`/bots/${r.botId}`}>{r.name}</Link>{' '}
                    {r.kind === 'house' && <span className="chip chip-house">house</span>}
                  </td>
                  <td className="soft">{r.ownerName ?? 'punklabz'}</td>
                  <td className="num">
                    <span className={`pill ${pillClass(r.pnlPct)}`}>
                      {fmtPct(r.pnlPct)} {arrow(r.pnlPct)}
                    </span>
                  </td>
                  <td className={`num ${pnlColor(r.pnlUsd)}`}>
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
        </div>
      </Panel>
    </div>
  );
}

function pnlColor(n: number): string {
  return n >= 0 ? 'pnl-pos' : 'pnl-neg';
}
