import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { glyphs } from '../lib/glyphs';
import { useAuth } from '../lib/auth';

export function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
      const provider = (window as any).solana;
      if (!provider?.isPhantom && !provider) {
        throw new Error('no solana wallet found — install Phantom or use email');
      }
      const { publicKey } = await provider.connect();
      const address = publicKey.toString();
      const { message } = await api.get<{ nonce: string; message: string }>(
        `/api/auth/wallet/nonce?address=${encodeURIComponent(address)}`,
      );
      const encoded = new TextEncoder().encode(message);
      const signed = await provider.signMessage(encoded, 'utf8');
      // Phantom returns { signature: Uint8Array }; encode as base58
      const sigBytes: Uint8Array = signed.signature ?? signed;
      const signature = b58encode(sigBytes);
      await api.post('/api/auth/wallet/verify', { address, signature });
      await done();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-box">
        <Panel title="Welcome to Punklabz" sub="paper trading arena" noPad>
          <div className="login-cols">
            <div className="login-mosaic">
              <pre className="glyphs faint">{glyphs(14, 6, 42)}</pre>
              <div className="acid-block" />
            </div>
            <div className="login-col">
              <div className="acid">Wallet</div>
              <p className="dim">Sign a message with your Solana wallet. No password, no email.</p>
              <button className="primary" onClick={walletLogin} disabled={busy}>
                Connect wallet
              </button>
            </div>
            <div className="login-col">
              <div className="acid">{mode === 'login' ? 'Email' : 'Create account'}</div>
              {mode === 'register' && (
                <input
                  placeholder="display name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
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
                {mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
              <a
                onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
                style={{ cursor: 'pointer' }}
                className="dim"
              >
                {mode === 'login' ? 'Need an account? Register →' : '← Back to sign in'}
              </a>
            </div>
          </div>
          {err && <div className="panel-body error-text">{err}</div>}
          <div className="panel-body dim" style={{ fontSize: 11 }}>
            New accounts get $100 in demo credits · paper trading only — no real funds involved
          </div>
        </Panel>
      </div>
    </div>
  );
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
