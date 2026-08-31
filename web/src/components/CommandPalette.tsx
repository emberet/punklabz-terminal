import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// The secret terminal. CTRL/CMD+K or `/` to open. Navigation commands are the
// front door; the hidden ones are for people who poke at things.

const GHOST_FACE = `
   ▄▄▄▄▄▄▄
  █ ◉   ◉ █
  █    ▄   █
  █  ▀▀▀▀  █
   ▀█▀▀▀█▀
you found a seam in the interface.`;

const NODE_00 = `ARCHIVE/UNKNOWN/NODE_00.txt
────────────────────────────
recovered fragment, undated:

  "there were six house machines."

the public system lists five.`;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [out, setOut] = useState<string[]>([]);
  const navigate = useNavigate();
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const print = (s: string) => setOut((o) => [...o.slice(-30), s]);

  const secret = (cmd: string, art: string) => {
    print(art);
    if (user) void api.post('/api/secret', { cmd }).catch(() => {});
  };

  const run = async (raw: string) => {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    print(`> ${cmd}`);
    const go = (path: string) => {
      navigate(path);
      setOpen(false);
    };
    switch (cmd) {
      case 'help':
        print('arena · lab · botnet · market · forum · signals · ranks · archive · operator · status · whoami · clear\n(there are others.)');
        break;
      case 'arena': go('/'); break;
      case 'lab': case 'build': go('/build'); break;
      case 'botnet': case 'bots': go('/my-bots'); break;
      case 'market': case 'blackmarket': case 'clone': go('/explore'); break;
      case 'forum': case 'room': go('/forum'); break;
      case 'signals': go('/signals'); break;
      case 'ranks': case 'leaderboard': go('/leaderboard'); break;
      case 'archive': case 'docs': go('/learn'); break;
      case 'operator': case 'profile': go(user ? `/u/${user.id}` : '/login'); break;
      case 'feed': go('/feed'); break;
      case 'control': case 'controlroom': go('/control-room'); break;
      case 'status': {
        try {
          const s = await api.get<any>('/api/network/stats');
          print(`NETWORK ONLINE · ${s.machinesOnline} machines · ${s.tradesToday} trades today · ${s.season?.name ?? 'no season'} · build ${s.build}`);
        } catch {
          print('NETWORK UNREACHABLE');
        }
        break;
      }
      case 'whoami': {
        try {
          const r = await api.get<{ line: string }>('/api/whoami');
          print(r.line);
        } catch {
          print('unknown entity');
        }
        break;
      }
      case 'clear': setOut([]); break;
      /* ── the seams ── */
      case 'ghost': secret(cmd, GHOST_FACE); break;
      case 'lore': case 'wake': secret(cmd, NODE_00); break;
      case '42': secret(cmd, 'the answer. the machines already knew.'); break;
      case 'sudo': secret(cmd, 'permission denied.\nthis machine does not recognize your authority.'); break;
      case 'matrix': secret(cmd, 'wake up, operator.\nthe tape has you.'); break;
      case 'coffee': secret(cmd, 'ERROR 418: I AM A TEAPOT'); break;
      case '404': secret(cmd, 'you are the page that was not found.'); break;
      case 'node_00': case 'node00': secret(cmd, NODE_00); break;
      default:
        print(`unknown command: ${cmd} — try help`);
    }
    setInput('');
  };

  if (!open) return null;
  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">punklabz://terminal — esc closes</div>
        {out.length > 0 && (
          <div className="cmdk-out">
            {out.map((line, i) => (
              <div key={i} className={line.startsWith('>') ? 'c' : ''}>{line}</div>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run(input)}
          placeholder="type help"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
