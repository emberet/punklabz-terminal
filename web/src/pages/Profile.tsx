import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProfileView } from '@punklabz/shared';
import { BADGES } from '@punklabz/shared';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { arrow, fmtUsd, fmtPct, fmtDate, pillClass } from '../lib/format';
import { useAuth } from '../lib/auth';

export function Profile() {
  const { id } = useParams();
  const { user } = useAuth();
  const [p, setP] = useState<ProfileView | null>(null);
  const [err, setErr] = useState('');

  const load = () => api.get<ProfileView>(`/api/users/${id}`).then(setP).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
  }, [id]);

  if (err) return <div className="red">{err}</div>;
  if (!p) return <div className="dim">loading…</div>;

  const isMe = user?.id === p.user.id;
  const xpPct = p.user.nextLevelAt ? Math.min(100, (p.user.xp / p.user.nextLevelAt) * 100) : 100;

  const follow = async () => {
    await api.post('/api/follow/toggle', { targetType: 'user', targetId: p.user.id });
    void load();
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <div className="page-title row" style={{ gap: 12 }}>
            {p.user.displayName}
            <span className="chip chip-house">LVL {p.user.level} · {p.user.levelTitle}</span>
          </div>
          <div className="page-sub">
            Quant since {fmtDate(p.user.createdAt)} · {p.followers} followers · following {p.following}
          </div>
        </div>
        {user && !isMe && (
          <button className={p.isFollowing ? '' : 'primary'} onClick={follow}>
            {p.isFollowing ? 'Following ✓' : 'Follow'}
          </button>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 14 }}>
        <div className="stat-tile invert">
          <div className="label">Best rank</div>
          <div className="value">{p.bestRank ? `#${p.bestRank}` : '—'}</div>
        </div>
        <div className={`stat-tile ${p.portfolioPnlUsd > 0 ? 'pos' : p.portfolioPnlUsd < 0 ? 'neg' : ''}`}>
          <div className="label">Portfolio P&L</div>
          <div className="value">
            {p.portfolioPnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(p.portfolioPnlUsd), 0)}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Bots</div>
          <div className="value">{p.bots.length}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Clones received</div>
          <div className="value">{p.clonesReceived}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Creator earnings</div>
          <div className="value">${fmtUsd(p.creatorEarningsUsd, 0)}</div>
        </div>
      </div>

      <Panel title="Progress" noPad>
        <div className="panel-body">
          <div className="row" style={{ gap: 16 }}>
            <span className="acid" style={{ fontFamily: 'var(--font)' }}>
              {p.user.xp} XP
            </span>
            <div style={{ flex: 1, height: 8, background: 'var(--bg-raised)' }}>
              <div style={{ width: `${xpPct}%`, height: '100%', background: 'var(--acid)' }} />
            </div>
            <span className="dim">
              {p.user.nextLevelAt ? `${p.user.nextLevelAt - p.user.xp} XP to next level` : 'max level'}
            </span>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {p.badges.length === 0 && <span className="dim">No badges yet.</span>}
            {p.badges.map((b, i) => {
              const meta = BADGES[b.badge] ?? { label: b.badge, description: '' };
              return (
                <span key={i} className="chip chip-house" title={meta.description}>
                  ◈ {meta.label}
                </span>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel title="Strategies" noPad>
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
              {p.bots.length === 0 && <tr><td colSpan={5} className="dim">No bots yet.</td></tr>}
              {p.bots.map((b) => (
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
    </div>
  );
}
