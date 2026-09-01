import { useCallback, useEffect, useState } from 'react';
import { Panel } from './Panel';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  ROBINHOOD_CHAIN_ID, WalletError, type ConnectorKind, activeConnector, currentChainId,
  disconnectProvider, hasWallet, restoreConnector, shortAddress,
  switchToRobinhoodChain, walletConnectToAccount,
} from '../lib/wallet';

interface TokenBalance {
  symbol: string;
  name: string;
  assetClass: string;
  amount: number;
  decimals: number;
  underlyingExposure: number | null;
  multiplier: string | null;
  usdValue: number | null;
  priceSource: 'reference' | 'mark' | 'par' | null;
  priceStale: boolean;
}

interface Portfolio {
  address: string;
  chainId: number;
  ok: boolean;
  error: string | null;
  gas: TokenBalance;
  settlement: TokenBalance;
  tokens: TokenBalance[];
  totalUsd: number;
  unpricedCount: number;
  degraded: boolean;
  fetchedAt: number;
}

const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** never round a balance to zero — a tiny holding is not no holding */
function amountText(n: number, decimals: number): string {
  if (n === 0) return '0';
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(decimals, 6) });
}

const SOURCE_LABEL: Record<string, string> = {
  reference: 'reference price',
  mark: 'feed mark',
  par: 'par (1:1 redeemable)',
};

export function WalletPanel() {
  const { user, refresh } = useAuth();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  /** which button is mid-handshake, so only that one shows as waiting */
  const [pending, setPending] = useState<ConnectorKind | null>(null);

  const connected = !!user?.walletAddress;

  const loadPortfolio = useCallback(() => {
    if (!connected) { setPortfolio(null); return; }
    setLoading(true);
    api.get<Portfolio>('/api/wallet/portfolio')
      .then(setPortfolio)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [connected]);

  useEffect(() => {
    loadPortfolio();
    if (!connected) return;
    const t = setInterval(loadPortfolio, 60_000);
    return () => clearInterval(t);
  }, [loadPortfolio, connected]);

  useEffect(() => {
    // a WalletConnect session survives a reload; pick it back up before asking
    // the chain anything, or we read the extension's chain instead of the phone's
    void restoreConnector().then(() => currentChainId().then(setChainId));
  }, [user]);

  const connect = async (kind: ConnectorKind) => {
    setBusy(true); setPending(kind); setError(null); setNotice(null);
    try {
      const { address, isAdmin, merged } = await walletConnectToAccount(kind);
      await refresh();
      setNotice(
        merged
          ? `${shortAddress(address)} verified — wallet and email profiles combined.`
          : isAdmin
          ? `${shortAddress(address)} connected — operator clearance granted.`
          : `${shortAddress(address)} connected.`,
      );
      void currentChainId().then(setChainId);
      loadPortfolio();
    } catch (e) {
      setError(e instanceof WalletError ? e.message : String((e as Error)?.message ?? e));
    } finally {
      setBusy(false); setPending(null);
    }
  };

  const disconnect = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      // drop the wallet-side session too, not just our record of it
      await disconnectProvider();
      await api.post('/api/auth/wallet/unlink');
      await refresh();
      setPortfolio(null);
      setNotice('Wallet disconnected. Operator clearance is withdrawn with it.');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  const wrongChain = chainId !== null && chainId !== ROBINHOOD_CHAIN_ID;
  const isOperator = !!user.isAdmin;

  return (
    <Panel
      title="WALLET"
      sub={connected ? shortAddress(user.walletAddress!) : 'not connected'}
      noPad
    >
      <div className="panel-body">
        {notice && <div className="phos" style={{ marginBottom: 8 }}>{notice}</div>}
        {error && <div className="red" style={{ marginBottom: 8 }}>{error}</div>}

        {!connected && (
          <>
            <div className="soft" style={{ marginBottom: 8 }}>
              Connect an EVM wallet to see your Robinhood Chain balances. This asks for a
              signature, not a transaction — it costs nothing and moves nothing.
            </div>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <button
                className="primary"
                onClick={() => void connect('injected')}
                disabled={busy || !hasWallet()}
              >
                {pending === 'injected' ? '[ waiting for signature… ]' : '[ Browser wallet ]'}
              </button>
              <button onClick={() => void connect('walletconnect')} disabled={busy}>
                {pending === 'walletconnect' ? '[ waiting for signature… ]' : '[ WalletConnect ]'}
              </button>
            </div>
            <div className="soft" style={{ marginTop: 8 }}>
              {hasWallet()
                ? 'Browser wallet uses the extension in this browser. WalletConnect scans a QR code with a wallet on your phone.'
                : 'No extension wallet in this browser — WalletConnect will show a QR code you scan with your phone.'}
            </div>
          </>
        )}

        {connected && (
          <>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
              <span className="soft" style={{ width: 130 }}>ADDRESS</span>
              <span className="phos" style={{ wordBreak: 'break-all' }}>{user.walletAddress}</span>
            </div>
            {activeConnector() && (
              <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                <span className="soft" style={{ width: 130 }}>CONNECTED VIA</span>
                <span className="soft">
                  {activeConnector() === 'walletconnect' ? 'WalletConnect' : 'browser extension'}
                </span>
              </div>
            )}
            <div className="row" style={{ gap: 16, marginBottom: 8 }}>
              <span className="soft" style={{ width: 130 }}>CLEARANCE</span>
              <span className={isOperator ? 'phos' : 'soft'}>
                {isOperator ? 'OPERATOR — Control Room unlocked' : 'standard operator account'}
              </span>
            </div>
            {!isOperator && (
              <div className="soft" style={{ marginBottom: 8 }}>
                Control Room access requires the separately configured human operator wallet.
              </div>
            )}
            {wrongChain && (
              <div className="red" style={{ marginBottom: 8 }}>
                Your wallet is on chain {chainId}. Balances below are read from Robinhood Chain
                (4663) regardless — this only matters when you come to sign a transaction.{' '}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => void switchToRobinhoodChain().then(() => currentChainId().then(setChainId))}
                >
                  [ switch network ]
                </button>
              </div>
            )}
            <div className="row" style={{ gap: 10 }}>
              <button onClick={loadPortfolio} disabled={loading}>
                {loading ? 'reading chain…' : 'REFRESH'}
              </button>
              <button className="danger" onClick={() => void disconnect()} disabled={busy}>
                DISCONNECT
              </button>
            </div>
          </>
        )}
      </div>

      {connected && portfolio && !portfolio.ok && (
        <div className="panel-body red" style={{ borderTop: '1px solid var(--border)' }}>
          {portfolio.error}
        </div>
      )}

      {connected && portfolio?.ok && (
        <>
          <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="soft">TOTAL PORTFOLIO VALUE</div>
            <div className="phos" style={{ fontSize: 30, lineHeight: 1.2 }}>
              {usd(portfolio.totalUsd)}
            </div>
            <div className="soft" style={{ marginTop: 4 }}>
              on Robinhood Chain · read from the chain{' '}
              {new Date(portfolio.fetchedAt).toISOString().slice(11, 19)} UTC
            </div>
            {portfolio.degraded && (
              <div className="red" style={{ marginTop: 6 }}>
                At least one price used here is stale. Treat the total as indicative.
              </div>
            )}
            {portfolio.unpricedCount > 0 && (
              <div className="soft" style={{ marginTop: 6 }}>
                {portfolio.unpricedCount} holding(s) have no price we trust and are excluded from
                the total rather than guessed at.
              </div>
            )}
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>asset</th>
                  <th className="num">balance</th>
                  <th className="num">value</th>
                  <th>priced from</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="phos">ETH<span className="soft"> · gas</span></td>
                  <td className="num">{amountText(portfolio.gas.amount, 18)}</td>
                  <td className="num">
                    {portfolio.gas.usdValue === null ? <span className="soft">—</span> : usd(portfolio.gas.usdValue)}
                  </td>
                  <td className="soft">{portfolio.gas.priceSource ? SOURCE_LABEL[portfolio.gas.priceSource] : 'no ETH/USD mark'}</td>
                </tr>
                <tr>
                  <td className="phos">USDG<span className="soft"> · settlement</span></td>
                  <td className="num">{amountText(portfolio.settlement.amount, 6)}</td>
                  <td className="num">{usd(portfolio.settlement.usdValue ?? 0)}</td>
                  <td className="soft">{SOURCE_LABEL.par}</td>
                </tr>
                {portfolio.tokens.map((t) => (
                  <tr key={t.symbol}>
                    <td>
                      <span className="phos">{t.symbol}</span>
                      {(t.assetClass === 'STOCK_TOKEN' || t.assetClass === 'ETF_TOKEN') && (
                        <span className="soft"> · stock token</span>
                      )}
                      {t.underlyingExposure !== null && t.multiplier !== '1.000000000000000000' && (
                        <div className="soft" style={{ fontSize: '0.9em' }}>
                          ×{Number(t.multiplier).toFixed(4)} → {amountText(t.underlyingExposure, 6)} underlying
                        </div>
                      )}
                    </td>
                    <td className="num">{amountText(t.amount, t.decimals)}</td>
                    <td className="num">
                      {t.usdValue === null ? <span className="soft">—</span> : usd(t.usdValue)}
                    </td>
                    <td className={t.priceStale ? 'red' : 'soft'}>
                      {t.priceSource ? SOURCE_LABEL[t.priceSource] : 'unpriced'}
                      {t.priceStale && ' (stale)'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {portfolio.tokens.length === 0 && (
            <div className="panel-body soft" style={{ borderTop: '1px solid var(--border)' }}>
              No stock tokens held. Only assets with a non-zero balance are listed.
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
