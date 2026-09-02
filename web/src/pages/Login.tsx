import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { AsciiEntity } from '../components/AsciiEntity';
import { DecryptText } from '../components/motion/DecryptText';
import { useAuth } from '../lib/auth';
import { type ConnectorKind, hasWallet, walletSignIn } from '../lib/wallet';
import { usePageMeta } from '../lib/pageMeta';
import { useIdentityToken, usePrivy } from '@privy-io/react-auth';

interface NetStats {
  machinesOnline: number;
  tradesToday: number;
  operators: number;
  season: { name: string; endsAt: number } | null;
}

export function Login() {
  usePageMeta('Access', 'Sign in with a wallet or an email to build machines and enter the arena.');
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
  /** which wallet button is mid-handshake, so only that one shows as waiting */
  const [pending, setPending] = useState<ConnectorKind | null>(null);

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
      await api.post('/api/auth/login', { email, password });
      await done();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const walletLogin = async (kind: ConnectorKind) => {
    setBusy(true);
    setPending(kind);
    setErr('');
    try {
      await walletSignIn(kind);
      await done();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  if (phase === 'boot') {
    return (
      <div className="boot-screen">
        <h1 className="page-title" style={{ fontSize: 40 }}>
          <DecryptText text="PUNKLABZ NETWORK" duration={500} />
        </h1>
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
          <h1 className="page-title" style={{ fontSize: 46 }}>Punklabz Network</h1>
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
            {import.meta.env.VITE_PRIVY_APP_ID && (
              <PrivyAccess onDone={done} onError={setErr} />
            )}
            <div className="login-mosaic" style={{ alignItems: 'center', justifyContent: 'center', padding: 8 }}>
              <AsciiEntity width={24} height={16} fontSize={9} />
            </div>
            <div className="login-col">
              <div className="phos">WALLET</div>
              <p className="dim">
                Sign a message with your EVM wallet. No password, no email. A signature is not a
                transaction — it costs nothing and moves nothing.
              </p>
              <button
                className="primary"
                onClick={() => void walletLogin('injected')}
                disabled={busy || !hasWallet()}
              >
                {pending === 'injected' ? '[ waiting for signature… ]' : '[ Browser wallet ]'}
              </button>
              <button onClick={() => void walletLogin('walletconnect')} disabled={busy}>
                {pending === 'walletconnect' ? '[ waiting for signature… ]' : '[ WalletConnect ]'}
              </button>
              <p className="dim">
                {hasWallet()
                  ? 'Or scan a QR code with a wallet on your phone.'
                  : 'No extension wallet here — WalletConnect shows a QR code for your phone.'}
              </p>
            </div>
            <div className="login-col">
              <div className="phos">LEGACY CREDENTIALS</div>
              <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input
                placeholder="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
              />
              <button onClick={submitEmail} disabled={busy}>
                [ Connect existing account ]
              </button>
              <span className="dim">New accounts initialize through Privy.</span>
            </div>
          </div>
          {err && <div className="panel-body error-text">{err}</div>}
          <div className="boot-stats">
            <span><b>{stats?.machinesOnline ?? '—'}</b> MACHINES ONLINE</span>
            <span><b>{stats?.tradesToday ?? '—'}</b> TRADES TODAY</span>
            <span><b>{stats?.operators ?? '—'}</b> OPERATORS</span>
            {stats?.season && <span><b>{stats.season.name}</b> RUNNING</span>}
            <span className="amber">PAPER LAB + GATED MAINNET</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PrivyAccess({ onDone, onError }: { onDone: () => Promise<void>; onError: (message: string) => void }) {
  const { ready, authenticated, login } = usePrivy();
  const { identityToken } = useIdentityToken();
  const [syncing, setSyncing] = useState(false);
  const processed = useRef<string | null>(null);

  useEffect(() => {
    if (!authenticated || !identityToken || processed.current === identityToken) return;
    processed.current = identityToken;
    setSyncing(true);
    api.post('/api/auth/privy', { identityToken })
      .then(() => onDone())
      .catch((error) => {
        processed.current = null;
        onError(error.message);
      })
      .finally(() => setSyncing(false));
  }, [authenticated, identityToken]);

  return (
    <div className="login-col" style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border)' }}>
      <div className="phos">PRIVY IDENTITY + EMBEDDED WALLET</div>
      <p className="dim">New operators enter here. Email and wallet can be linked to the same identity; keys stay inside Privy.</p>
      <button className="primary" disabled={!ready || syncing} onClick={() => login()}>
        {syncing || (authenticated && !identityToken) ? '[ verifying identity… ]' : '[ Enter with Privy ]'}
      </button>
    </div>
  );
}
