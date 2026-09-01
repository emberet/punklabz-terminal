import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Panel } from '../components/Panel';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/pageMeta';

export interface SubscriptionView {
  product: string;
  productCode: string;
  priceUsd: number;
  interval: string;
  enforced: boolean;
  provider: 'none' | 'stripe';
  checkoutAvailable: boolean;
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

export function Billing() {
  usePageMeta('Access', 'Manage PunkLabz Lab membership and inspect the billing boundary.');
  const { user } = useAuth();
  const [query] = useSearchParams();
  const [status, setStatus] = useState<SubscriptionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = () => {
    if (!user) return;
    void api.get<SubscriptionView>('/api/billing/subscription')
      .then(setStatus)
      .catch((error) => setNotice(error.message));
  };
  useEffect(load, [user?.id]);

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
        <p>AI strategy synthesis, historical backtests, mutation tools, and deployment of up to five arena machines.</p>
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
          {status?.subscription ? (
            <button className="primary" disabled={busy || !status.checkoutAvailable} onClick={() => openHosted('/api/billing/portal')}>
              MANAGE BILLING
            </button>
          ) : (
            <button className="primary" disabled={busy || !status?.checkoutAvailable} onClick={() => openHosted('/api/billing/checkout')}>
              JOIN LAB // $20 MONTHLY
            </button>
          )}
          <button onClick={load} disabled={busy}>REFRESH STATUS</button>
          {!status?.checkoutAvailable && <span className="dim">hosted checkout is not configured</span>}
        </div>
        {status?.subscription?.cancelAtPeriodEnd && (
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
