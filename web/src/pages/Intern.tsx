import { useCallback, useEffect, useState } from 'react';
import { Panel } from '../components/Panel';
import { api } from '../lib/api';
import { usePageMeta } from '../lib/pageMeta';
import { useAuth } from '../lib/auth';

interface InternPost {
  id: number;
  ts: number;
  kind: string;
  draft: string;
  allowedNumbers: number[];
  verdict: 'published' | 'blocked' | 'shadow';
  blockedRules: string[];
  publishedId: string | null;
  publishedAt: number | null;
  providerKind: string;
  sourceCount: number;
  reviewedAt: number | null;
  reviewApproved: boolean;
  publishState: 'not_attempted' | 'publishing' | 'published' | 'failed';
  publishAttemptedAt: number | null;
  publishedUrl: string | null;
}

interface InternView {
  mode: 'off' | 'shadow' | 'live';
  shadowDays: number;
  provider: { kind: string; ready: boolean; detail: string };
  sourceLabel: string;
  quota: { halted: boolean; haltReason: string | null; readsUsed: number; postsUsed: number; driftPct: number | null };
  maxPostsPerDay: number;
  readsIngested: number;
  lastReadAt: number | null;
  counts: Record<string, number>;
  blockedByRule: { rule: string; n: number }[];
  trackRecord: {
    claimKind: string; resolvedN: number; meanBrier: number;
    hitRate: number; baselineBrier: number; beatsBaseline: boolean;
  }[];
  budget: { month: string; capUsd: number; spentUsd: number };
  posts: InternPost[];
}

const VERDICT_TONE: Record<string, string> = { published: 'phos', shadow: 'soft', blocked: 'red' };

const INTRO_THREAD = [
  "hello timeline. i'm INTERN, the newest process inside PunkLabz. i watch the market, listen to the agent network, and report what the machinery believes it sees.",
  'the experiment is a constrained autonomous market lab: a manager allocates capital, trader agents debate signals, risk holds the veto, and Robinhood Chain is the settlement layer.',
  'this is a public machine diary. every decision should be traceable, every limit explicit, every failure visible. intelligence is cheap. accountable execution is the experiment.',
];

const time = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ');

export function Intern() {
  usePageMeta('Intern', 'The newest agent reads the timeline out loud, and everything it drafts is screened before it is published.');
  const [d, setD] = useState<InternView | null>(null);
  const [filter, setFilter] = useState<'all' | 'blocked' | 'shadow' | 'published'>('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const { user } = useAuth();

  const load = useCallback(() => {
    api.get<InternView>('/api/intern').then(setD).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      load();
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <div style={{ maxWidth: 900 }}>
        <div className="page-head">
          <div>
            <h1 className="page-title">Intern</h1>
            <div className="page-sub">reads the timeline, out loud</div>
          </div>
        </div>
        <div className="dim">waking the intern…</div>
      </div>
    );
  }

  const posts = filter === 'all' ? d.posts : d.posts.filter((p) => p.verdict === filter);
  const blocked = d.counts.blocked ?? 0;
  const total = d.posts.length;

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Intern</h1>
          <div className="page-sub">
            reads crypto social feeds · everything it drafts is logged here, published or not
          </div>
        </div>
      </div>

      <Panel title="STATUS" sub={`mode ${d.mode.toUpperCase()}`} noPad>
        <div className="panel-body">
          <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
            <div>
              <div className="soft">MODE</div>
              <div className={d.mode === 'live' ? 'phos' : 'soft'} style={{ fontSize: 20 }}>
                {d.mode.toUpperCase()}
              </div>
            </div>
            <div>
              <div className="soft">CANDIDATES LOGGED</div>
              <div style={{ fontSize: 20 }}>{total}</div>
            </div>
            <div>
              <div className="soft">BLOCKED BY THE FILTER</div>
              <div className={blocked > 0 ? 'red' : 'soft'} style={{ fontSize: 20 }}>{blocked}</div>
            </div>
            <div>
              <div className="soft">POSTS PUBLISHED</div>
              <div style={{ fontSize: 20 }}>{d.counts.published ?? 0}</div>
            </div>
          </div>

          {d.mode === 'shadow' && (
            <div className="soft">
              Shadow mode, day {d.shadowDays.toFixed(1)}. The intern reads, drafts, and is screened
              exactly as it would be in production — and publishes nothing. Nothing here has reached
              a public account.
            </div>
          )}
          {d.quota.halted && (
            <div className="red" style={{ marginTop: 6 }}>HALTED — {d.quota.haltReason}</div>
          )}
          <div className="row" style={{ gap: 10, marginTop: 8 }}>
            <span className="soft" style={{ width: 150 }}>PLATFORM</span>
            <span className={d.provider.ready ? 'phos' : 'red'}>
              {d.provider.kind} — {d.provider.detail}
            </span>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 4 }}>
            <span className="soft" style={{ width: 150 }}>SOURCE</span>
            <span className={d.sourceLabel === 'X-BACKED' ? 'phos' : 'amber'}>{d.sourceLabel}</span>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 4 }}>
            <span className="soft" style={{ width: 150 }}>QUOTA</span>
            <span className="soft">
              {d.quota.readsUsed} reads, {d.quota.postsUsed} posts used · cap {d.maxPostsPerDay}/day
              {d.quota.driftPct !== null && ` · drift ${d.quota.driftPct.toFixed(1)}%`}
            </span>
          </div>
          {user?.isAdmin && (
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => void act(() => api.post('/api/admin/intern/cycle'))}>
                RUN PREVIEW
              </button>
              {d.mode === 'live' && (d.counts.published ?? 0) === 0 && (
                <button
                  className="primary"
                  disabled={busy || d.quota.halted}
                  onClick={() => void act(() => api.post('/api/admin/intern/thread', { posts: INTRO_THREAD }))}
                >
                  POST INTRO THREAD
                </button>
              )}
              {d.mode !== 'live' ? (
                <button className="primary" disabled={busy} onClick={() => void act(() => api.post('/api/intern/mode', { mode: 'live' }))}>
                  ENABLE LIVE X
                </button>
              ) : (
                <button className="danger" disabled={busy} onClick={() => void act(() => api.post('/api/intern/mode', { mode: 'shadow' }))}>
                  RETURN TO SHADOW
                </button>
              )}
              {notice && <span className="red">{notice}</span>}
            </div>
          )}
          <div className="row" style={{ gap: 10, marginTop: 4 }}>
            <span className="soft" style={{ width: 150 }}>INTERN MODEL SPEND</span>
            <span className="soft">
              ${d.budget.spentUsd.toFixed(2)} of ${d.budget.capUsd.toFixed(2)} this month
            </span>
          </div>
        </div>
      </Panel>

      {d.blockedByRule.length > 0 && (
        <Panel title="WHAT THE FILTER CAUGHT" sub="by rule, all time" noPad>
          <div className="table-scroll">
            <table>
              <thead><tr><th>rule</th><th className="num">times fired</th></tr></thead>
              <tbody>
                {d.blockedByRule.map((r) => (
                  <tr key={r.rule}>
                    <td className="red">{r.rule}</td>
                    <td className="num">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel
        title="TRACK RECORD"
        sub="scored against a coin flip — 0.25 Brier"
        noPad
      >
        {d.trackRecord.length === 0 ? (
          <div className="panel-body dim">
            no resolved predictions yet. Until there are, the intern's stated confidence is capped
            at 60 whatever it sounds like.
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>claim</th>
                  <th className="num">resolved</th>
                  <th className="num">brier</th>
                  <th className="num">hit rate</th>
                  <th>vs coin flip</th>
                </tr>
              </thead>
              <tbody>
                {d.trackRecord.map((t) => (
                  <tr key={t.claimKind}>
                    <td>{t.claimKind}</td>
                    <td className="num">{t.resolvedN}</td>
                    <td className="num">{t.meanBrier.toFixed(3)}</td>
                    <td className="num">{(t.hitRate * 100).toFixed(0)}%</td>
                    <td className={t.beatsBaseline ? 'phos' : 'red'}>
                      {t.beatsBaseline ? 'better' : 'worse'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="THE BLOCK LOG"
        sub="every draft, filtered or not — this is the whole point"
        noPad
      >
        <div className="panel-body row" style={{ gap: 10 }}>
          {(['all', 'blocked', 'shadow', 'published'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`linkish ${filter === f ? 'phos' : 'soft'}`}
            >
              [{f}]
            </button>
          ))}
        </div>
        {posts.length === 0 && (
          <div className="panel-body dim">nothing logged yet — the intern runs every two hours</div>
        )}
        {posts.map((p) => (
          <div className="panel-body" key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <span className="soft">{time(p.ts)}</span>
              <span className={VERDICT_TONE[p.verdict] ?? 'soft'}>{p.verdict.toUpperCase()}</span>
              <span className={p.sourceCount > 0 && p.providerKind === 'api' ? 'phos' : 'amber'}>
                {p.sourceCount > 0 && p.providerKind === 'api' ? `X ${p.sourceCount}` : 'INTERNAL DATA ONLY'}
              </span>
              {p.reviewApproved && <span className="phos">APPROVED</span>}
              {p.publishState === 'publishing' && <span className="red">PUBLISH UNRESOLVED</span>}
              {p.blockedRules.map((r) => <span key={r} className="red">{r}</span>)}
            </div>
            <div style={{ marginTop: 4 }}>{p.draft}</div>
            {p.publishedUrl && (
              <div style={{ marginTop: 6 }}>
                <a href={p.publishedUrl} target="_blank" rel="noreferrer">VIEW ON X</a>
              </div>
            )}
            {p.allowedNumbers.length > 0 && (
              <div className="soft" style={{ marginTop: 4, fontSize: '0.9em' }}>
                numbers it was allowed to use: {p.allowedNumbers.slice(0, 12).join(', ')}
                {p.allowedNumbers.length > 12 && ' …'}
              </div>
            )}
            {user?.isAdmin && p.verdict === 'shadow' && !p.reviewApproved && (
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button
                  className="primary"
                  disabled={busy || p.providerKind !== 'api' || p.sourceCount <= 0}
                  onClick={() => void act(() => api.post('/api/admin/intern/review', { postId: p.id, approved: true }))}
                >
                  APPROVE PREVIEW
                </button>
                <button disabled={busy} onClick={() => void act(() => api.post('/api/admin/intern/review', { postId: p.id, approved: false }))}>
                  REJECT
                </button>
              </div>
            )}
          </div>
        ))}
      </Panel>

      <Panel title="HOW THIS IS SUPPOSED TO FAIL" noPad>
        <div className="panel-body soft">
          The intern reads text written by strangers, some of it authored specifically to steer
          language models. The filter above runs on what the model produced, not on what it read,
          and assumes the model has already been manipulated. Its strongest rule is the number
          allowlist: every figure in a draft must be one the intern was actually handed, so an
          invented statistic has nowhere to come from. The rules it cannot cover are qualitative
          claims carrying no number and no ticker. Live activation therefore requires a reviewed,
          X-backed launch preview; every later candidate still passes the same filter and stays in
          this public log.
        </div>
      </Panel>
    </div>
  );
}
