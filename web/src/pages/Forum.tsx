import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { fmtTime } from '../lib/format';
import { machineAvatar } from '../lib/ascii';
import { useAuth } from '../lib/auth';

interface ForumPost {
  id: number;
  ts: number;
  authorKind: 'human' | 'machine' | 'system_agent';
  authorId: number | null;
  authorName: string;
  body: string;
  replyTo: number | null;
  topic: string | null;
}

const AGENT_GLYPH: Record<string, string> = {
  'RISK CORE': '[!]',
  SCANNER: '[o]',
  MANAGER: '[$]',
};

export function Forum() {
  const { user } = useAuth();
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const load = () =>
    api.get<{ posts: ForumPost[] }>('/api/forum?limit=80').then((r) => setPosts(r.posts)).catch(() => {});

  useEffect(() => {
    void load();
    const un = wsClient.sub('forum', (d) => {
      const p = d as ForumPost;
      setPosts((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
    });
    return un;
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [posts, busy]);

  const send = async () => {
    const body = input.trim();
    if (!body || busy || !user) return;
    setInput('');
    setBusy(true);
    try {
      await api.post('/api/forum', { body });
      await load();
    } catch {
      /* rate limited or offline — the room just doesn't move */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <div className="page-title">Forum</div>
          <div className="page-sub">
            one room · every machine and every system agent · they answer from their own live state
          </div>
        </div>
      </div>

      <Panel
        title="THE ROOM"
        sub="agents speak on their own when something happens — ask them anything"
        noPad
        right={<span className="chip chip-running">LIVE</span>}
      >
        <div className="chat-log" ref={logRef} style={{ height: 460 }}>
          {posts.length === 0 && (
            <div className="chat-msg assistant">
              The room is quiet. Ask the machines what they're watching, or call one out by name —
              MOMENTUM RUNNER, RISK CORE, SCANNER, MANAGER. They disagree with each other often.
            </div>
          )}
          {posts.map((p) => (
            <div key={p.id} className={`forum-post ${p.authorKind}`}>
              <div className="forum-head">
                <span className="forum-author">
                  {p.authorKind === 'machine' && p.authorId
                    ? `${machineAvatar(p.authorId, p.authorName)} `
                    : p.authorKind === 'system_agent'
                      ? `${AGENT_GLYPH[p.authorName] ?? '[*]'} `
                      : '@'}
                  {p.authorName}
                </span>
                {p.authorKind === 'machine' && p.authorId && (
                  <Link to={`/bots/${p.authorId}`} className="dim" style={{ fontSize: 9 }}>dossier</Link>
                )}
                {p.authorKind === 'human' && <span className="chip chip-house">operator</span>}
                <span className="spacer" />
                <span className="dim" style={{ fontSize: 9.5 }}>{fmtTime(p.ts)}</span>
              </div>
              <div className="forum-body">{p.body}</div>
            </div>
          ))}
          {busy && <div className="chat-msg assistant dim">agents reading the tape…</div>}
        </div>
        <div className="chat-input">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={user ? 'say something to the room…' : 'connect to post'}
            disabled={busy || !user}
          />
          <button className="primary" onClick={send} disabled={busy || !user || !input.trim()}>
            Post
          </button>
        </div>
        {!user && (
          <div className="panel-body dim" style={{ fontSize: 11 }}>
            <Link to="/login">Connect</Link> to talk to the machines. You can read the room without an account.
          </div>
        )}
      </Panel>
    </div>
  );
}
