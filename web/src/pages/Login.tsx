import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { AsciiEntity } from '../components/AsciiEntity';
import { DecryptText } from '../components/motion/DecryptText';
import { useAuth } from '../lib/auth';
import { hasWallet, walletSignIn } from '../lib/wallet';

interface NetStats {
  machinesOnline: number;
  tradesToday: number;
  operators: number;
  season: { name: string; endsAt: number } | null;
}

export function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<NetStats | null>(null);
  const [phase, setPhase] = useState<'boot' | 'ready'>(() => {
    try {
      return localStorage.getItem('plz.booted') ? 'ready' : 'boot';
    } catch {
      return 'ready';
    }
  });
  const [bootLine, setBootLine] = useState(0);

  useEffect(() => {
    void api.get<NetStats>('/api/network/stats').then(setStats).catch(() => {});
  }, []);

  // first-visit handshake: ~2s max, skippable, never repeated
  useEffect(() => {
    if (phase !== 'boot') return;
    const timers = [
      setTimeout(() => setBootLine(1), 350),
      setTimeout(() => setBootLine(2), 750),
      setTimeout(() => setBootLine(3), 1150),
      setTimeout(() => finishBoot(), 1900),
    ];
    return () => timers.forEach(clearTimeout);
  }, [phase]);

  const finishBoot = () => {
    try {
      localStorage.setItem('plz.booted', '1');
    } catch { /* private mode */ }
    setPhase('ready');
  };

  const done = async () => {
    await refresh();
    navigate('/build');
  };

  const submitEmail = async () => {
    setBusy(true);
    setErr('');
    try {
      if (mode === 'register') {
        await api.post('/api/auth/register', { email, password, displayName });
      } else {
        await api.post('/api/auth/login', { email, password });
      }
      await done();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const walletLogin = async () => {
    setBusy(true);
    setErr('');
    try {
      await walletSignIn();
      await done();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'boot') {
    return (
      <div className="boot-screen">
        <div className="page-title" style={{ fontSize: 40 }}>
          <DecryptText text="PUNKLABZ NETWORK" duration={500} />
        </div>
        <div className="boot-log">
          <div className="cursor">HANDSHAKE REQUESTED…</div>
          {bootLine >= 1 && <div className="ok">[ OK ] NODE FOUND</div>}
          {bootLine >= 2 && <div className="ok">[ OK ] MARKET FEED CONNECTED</div>}
          {bootLine >= 3 && <div className="ok">[ OK ] {stats?.machinesOnline ?? '—'} MACHINES DISCOVERED</div>}
        </div>
        <button onClick={finishBoot}>SKIP</button>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="login-box glitch-in">
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div className="page-title" style={{ fontSize: 46 }}>Punklabz Network</div>
          <div className="soft" style={{ letterSpacing: 2, fontSize: 11, textTransform: 'uppercase' }}>
            Autonomous market research system
          </div>
          <div className="syslog" style={{ padding: '8px 0 0' }}>
            <span className="ln ok">[ OK ] market feeds connected</span>
            <span className="ln ok">[ OK ] {stats?.machinesOnline ?? '—'} machines online</span>
            <span className="ln cursor">ready. build machines. test strategies. enter the arena.</span>
          </div>
        </div>

        <Panel title="ACCESS" noPad>
          <div className="login-cols">
            <div className="login-mosaic" style={{ alignItems: 'center', justifyContent: 'center', padding: 8 }}>
              <AsciiEntity width={24} height={16} fontSize={9} />
            </div>
            <div className="login-col">
              <div className="phos">WALLET</div>
              <p className="dim">
                Sign a message with your EVM wallet. No password, no email. A signature is not a
                transaction — it costs nothing and moves nothing.
              </p>
              <button className="primary" onClick={walletLogin} disabled={busy || !hasWallet()}>
                {busy ? '[ waiting for signature… ]' : '[ Connect wallet ]'}
              </button>
              {!hasWallet() && (
                <p className="dim">No EVM wallet in this browser — use email, and connect a wallet later.</p>
              )}
            </div>
            <div className="login-col">
              <div className="phos">{mode === 'login' ? 'CREDENTIALS' : 'NEW OPERATOR'}</div>
              {mode === 'register' && (
                <input placeholder="operator handle" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              )}
              <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input
                placeholder="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
              />
              <button onClick={submitEmail} disabled={busy}>
                {mode === 'login' ? '[ Connect ]' : '[ Initialize operator ]'}
              </button>
              <a onClick={() => setMode(mode === 'login' ? 'register' : 'login')} style={{ cursor: 'pointer' }} className="dim">
                {mode === 'login' ? 'no account? initialize →' : '← back'}
              </a>
            </div>
          </div>
          {err && <div className="panel-body error-text">{err}</div>}
          <div className="boot-stats">
            <span><b>{stats?.machinesOnline ?? '—'}</b> MACHINES ONLINE</span>
            <span><b>{stats?.tradesToday ?? '—'}</b> TRADES TODAY</span>
            <span><b>{stats?.operators ?? '—'}</b> OPERATORS</span>
            {stats?.season && <span><b>{stats.season.name}</b> RUNNING</span>}
            <span className="amber">SIMULATION — NO REAL FUNDS</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
