import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Panel } from '../components/Panel';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/pageMeta';
import { sendUsdgTransfer } from '../lib/wallet';

export interface SubscriptionView {
  product: string;
  productCode: string;
  priceUsd: number;
  interval: string;
  enforced: boolean;
  provider: 'none' | 'stripe' | 'usdg';
  checkoutAvailable: boolean;
  usdgPaymentAvailable: boolean;
  linkedPayerWallets: string[];
  access: { allowed: boolean; reason: string };
  subscription: null | {
    status: string;
    currentPeriodStart: number;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  };
  needsEmail: boolean;
  demoCreditsSeparate: boolean;
  creatorPaymentsLive: boolean;
}

interface UsdgIntent {
  id: string;
  chainId: number;
  tokenAddress: string;
  payerAddress: string;
  recipientAddress: string;
  rawAmount: string;
  status: string;
  txHash: string | null;
  expiresAt: number;
  error: string | null;
}

const PENDING_MEMBERSHIP_KEY = 'punklabz.usdg-membership';

export function Billing() {
  usePageMeta('Access', 'Manage PunkLabz Lab membership and inspect the billing boundary.');
  const { user } = useAuth();
  const [query] = useSearchParams();
  const [status, setStatus] = useState<SubscriptionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [payer, setPayer] = useState('');
  const [pending, setPending] = useState<{ intent: UsdgIntent; txHash: string } | null>(null);

  const load = () => {
    if (!user) return;
    void api.get<SubscriptionView>('/api/billing/subscription')
      .then((next) => {
        setStatus(next);
        setPayer((current) => current || next.linkedPayerWallets?.[0] || '');
      })
      .catch((error) => setNotice(error.message));
  };
  useEffect(load, [user?.id]);
  useEffect(() => {
    if (!user) return;
    try {
      const stored = localStorage.getItem(`${PENDING_MEMBERSHIP_KEY}:${user.id}`);
      if (stored) setPending(JSON.parse(stored));
    } catch { /* a private browser may deny storage */ }
  }, [user?.id]);

  const openHosted = async (endpoint: '/api/billing/checkout' | '/api/billing/portal') => {
    setBusy(true);
    setNotice('');
    try {
      const { url } = await api.post<{ url: string }>(endpoint);
      window.location.assign(url);
    } catch (error: any) {
      setNotice(error.message);
      setBusy(false);
    }
  };

  const confirmPending = async (value = pending) => {
    if (!value) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api.post<{ intent: UsdgIntent; confirmations: number; periodEnd?: number }>(
        '/api/billing/usdg/confirm', { intentId: value.intent.id, txHash: value.txHash },
      );
      if (result.intent.status === 'confirmed') {
        setPending(null);
        try { localStorage.removeItem(`${PENDING_MEMBERSHIP_KEY}:${user?.id}`); } catch { /* ignored */ }
        setNotice('20 USDG finalized on Robinhood Chain. Membership is active.');
        load();
      } else {
        const next = { intent: result.intent, txHash: value.txHash };
        setPending(next);
        setNotice(`Onchain payment found. Waiting for finality: ${result.confirmations}/12 confirmations.`);
      }
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const payUsdg = async () => {
    if (!payer) return;
    setBusy(true);
    setNotice('');
    try {
      const created = await api.post<{ intent: UsdgIntent }>('/api/billing/usdg/intents', { payerAddress: payer });
      const txHash = await sendUsdgTransfer({
        payerAddress: created.intent.payerAddress,
        recipientAddress: created.intent.recipientAddress,
        rawAmount: created.intent.rawAmount,
      });
      const next = { intent: created.intent, txHash };
      setPending(next);
      try { localStorage.setItem(`${PENDING_MEMBERSHIP_KEY}:${user?.id}`, JSON.stringify(next)); } catch { /* ignored */ }
      await confirmPending(next);
    } catch (error: any) {
      setNotice(error.message);
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div className="page-head">
          <div>
            <h1 className="page-title">Access</h1>
            <div className="page-sub">LAB MEMBERSHIP // BILLING STATUS</div>
          </div>
        </div>
        <Panel title="OPERATOR IDENTITY REQUIRED" term>
          <p>Connect an email or wallet account before starting a Lab membership.</p>
          <p style={{ marginTop: 12 }}><Link to="/login"><button className="primary">CONNECT</button></Link></p>
        </Panel>
      </div>
    );
  }

  const checkoutResult = query.get('checkout');
  const accessLabel = !status ? 'CHECKING' : status.access.allowed ? 'OPEN' : 'LOCKED';
  const periodEnd = status?.subscription
    ? new Date(status.subscription.currentPeriodEnd).toISOString().slice(0, 10)
    : null;

  return (
    <div style={{ maxWidth: 920 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Access</h1>
          <div className="page-sub">LAB MEMBERSHIP // ONE PRODUCT // HARD BILLING BOUNDARY</div>
        </div>
      </div>

      {checkoutResult === 'success' && (
        <div className="banner ok" style={{ marginBottom: 12 }}>
          Checkout returned successfully. Access activates only after the signed provider webhook confirms payment.
        </div>
      )}
      {checkoutResult === 'cancelled' && (
        <div className="banner" style={{ marginBottom: 12 }}>Checkout cancelled. Nothing was charged here.</div>
      )}
      {notice && <div className="banner bad" style={{ marginBottom: 12 }}>{notice}</div>}

      <Panel title="PUNKLABZ LAB" sub="$20 / month" term>
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div><div className="stat-label">ACCESS</div><div className={!status ? 'dim' : status.access.allowed ? 'phos' : 'red'}>{accessLabel}</div></div>
          <div><div className="stat-label">STATUS</div><div>{status?.subscription?.status?.toUpperCase() ?? (status?.enforced ? 'NONE' : 'PREVIEW')}</div></div>
          <div><div className="stat-label">RENEWS / ENDS</div><div>{periodEnd ?? '—'}</div></div>
          <div><div className="stat-label">PROVIDER</div><div>{status?.provider?.toUpperCase() ?? '—'}</div></div>
        </div>
        <p>AI strategy synthesis, historical backtests, mutation tools, and unlimited paper-machine creation with fair-use rate limits.</p>
        <p style={{ marginTop: 10 }} className="soft">
          Membership pays for product access. It never becomes USDG trading capital, wallet balance, paper P&amp;L, or a Manager allocation.
        </p>
        {!status?.enforced && (
          <div className="banner" style={{ marginTop: 14 }}>
            BILLING PREVIEW — access is currently open and no membership is required yet.
          </div>
        )}
        {status?.needsEmail && (
          <div className="banner bad" style={{ marginTop: 14 }}>
            Link an email to receive the five-day renewal reminder.
          </div>
        )}
        <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
          {status?.provider === 'usdg' && status.usdgPaymentAvailable && (
            <>
              <select value={payer} onChange={(event) => setPayer(event.target.value)} disabled={busy}>
                {status.linkedPayerWallets.map((address) => (
                  <option key={address} value={address}>{address.slice(0, 8)}...{address.slice(-6)}</option>
                ))}
              </select>
              {!pending ? (
                <button className="primary" disabled={busy || !payer} onClick={() => void payUsdg()}>
                  {status.subscription ? 'RENEW 20 USDG' : 'PAY 20 USDG'}
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => void confirmPending()}>
                  CHECK 12-BLOCK FINALITY
                </button>
              )}
            </>
          )}
          {status?.provider !== 'usdg' && status?.subscription ? (
            <button className="primary" disabled={busy || !status.checkoutAvailable} onClick={() => openHosted('/api/billing/portal')}>
              MANAGE BILLING
            </button>
          ) : status?.provider !== 'usdg' ? (
            <button className="primary" disabled={busy || !status?.checkoutAvailable} onClick={() => openHosted('/api/billing/checkout')}>
              JOIN LAB // $20 MONTHLY
            </button>
          ) : null}
          <button onClick={load} disabled={busy}>REFRESH STATUS</button>
          {status?.provider === 'usdg' && !status.linkedPayerWallets.length && (
            <span className="dim">link a wallet to this account before paying</span>
          )}
          {status?.provider !== 'usdg' && !status?.checkoutAvailable && <span className="dim">hosted checkout is not configured</span>}
        </div>
        {status?.provider === 'usdg' && status?.subscription && (
          <div className="amber" style={{ marginTop: 12 }}>
            NO AUTO-RENEWAL — send the next 20 USDG before {periodEnd} to extend another 30 days.
          </div>
        )}
        {status?.provider !== 'usdg' && status?.subscription?.cancelAtPeriodEnd && (
          <div className="amber" style={{ marginTop: 12 }}>Cancellation is scheduled; access remains open through {periodEnd}.</div>
        )}
      </Panel>

      <Panel title="BLACK MARKET" sub="separate rail" term>
        <p>
          Strategy reuse remains priced at 10 demo credits in this release. Real $10 creator payments and withdrawals are disabled until their own payment, refund, tax, fraud, and payout review is complete.
        </p>
      </Panel>
    </div>
  );
}
