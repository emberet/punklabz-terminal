import { useState } from 'react';
import { Panel } from './Panel';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * The other half of the handshake: an account that signed in with a wallet
 * adds an email and password, so losing the wallet does not lose the account.
 *
 * Deliberately shown even once an email exists, as a confirmation rather than
 * an empty space — an operator should be able to see at a glance which ways
 * into their account are live.
 */
export function LinkEmailPanel() {
  const { user, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!user) return null;
  const hasEmail = !!user.email;
  const hasWallet = !!user.walletAddress;

  const submit = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const linked = await api.post<{ merged?: boolean }>('/api/auth/email/link', { email, password });
      await refresh();
      setNotice(linked.merged
        ? 'Email and wallet profiles combined. You can now sign in either way.'
        : 'Email added. You can now sign in either way.');
      setEmail(''); setPassword('');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="SIGN-IN METHODS" sub={hasEmail && hasWallet ? 'two ways in' : 'one way in'} noPad>
      <div className="panel-body">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span className="soft" style={{ width: 130 }}>EMAIL</span>
          <span className={hasEmail ? 'phos' : 'soft'}>{user.email ?? 'not set'}</span>
        </div>
        <div className="row" style={{ gap: 10, marginBottom: 10 }}>
          <span className="soft" style={{ width: 130 }}>WALLET</span>
          <span className={hasWallet ? 'phos' : 'soft'}>
            {user.walletAddress ?? 'not connected'}
          </span>
        </div>

        {hasEmail && hasWallet && (
          <div className="soft">
            Both are live. Either one signs you in, and they reach the same account.
          </div>
        )}

        {!hasEmail && (
          <>
            <div className="soft" style={{ marginBottom: 8 }}>
              You signed in with a wallet. Add an email and password as a second way in — without
              one, losing the wallet loses the account.
            </div>
            {notice && <div className="phos" style={{ marginBottom: 8 }}>{notice}</div>}
            {error && <div className="red" style={{ marginBottom: 8 }}>{error}</div>}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input
                placeholder="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ minWidth: 200 }}
              />
              <input
                placeholder="password (8+ characters)"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ minWidth: 200 }}
              />
              <button
                className="primary"
                onClick={() => void submit()}
                disabled={busy || !email || password.length < 8}
              >
                {busy ? 'saving…' : 'ADD EMAIL'}
              </button>
            </div>
          </>
        )}

        {hasEmail && !hasWallet && (
          <div className="soft">
            Connect a wallet above to see your Robinhood Chain balances.
          </div>
        )}
      </div>
    </Panel>
  );
}
