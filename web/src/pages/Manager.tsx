import { useEffect, useState } from 'react';
import type { EpochView, PayoutItemView } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { fmtUsd, fmtDate, shortAddr } from '../lib/format';
import { useAuth } from '../lib/auth';
import { LiveNetworkPanel } from '../components/LiveNetworkPanel';
import { usePageMeta } from '../lib/pageMeta';

export function Manager() {
  usePageMeta('Control Room', 'Live execution, risk limits and payout epochs. Operator clearance only.');
  const { user } = useAuth();
  const [epochs, setEpochs] = useState<EpochView[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [items, setItems] = useState<PayoutItemView[]>([]);
  const [detail, setDetail] = useState<EpochView | null>(null);
  const [audit, setAudit] = useState<{ entries: any[]; chain: { ok: boolean } } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!user?.isAdmin) return;
    void api.get<{ epochs: EpochView[] }>('/api/admin/manager/epochs').then((r) => {
      setEpochs(r.epochs);
      if (selected === null && r.epochs.length) setSelected(r.epochs[0].id);
    });
    void api.get<{ entries: any[]; chain: { ok: boolean } }>('/api/admin/manager/audit').then(setAudit).catch(() => {});
  };

  useEffect(() => {
    load();
    const un = wsClient.sub('manager', () => load());
    return un;
  }, [user?.isAdmin]);

  useEffect(() => {
    if (selected === null) return;
    void api
      .get<{ epoch: EpochView; items: PayoutItemView[] }>(`/api/admin/manager/epochs/${selected}`)
      .then((r) => {
        setDetail(r.epoch);
        setItems(r.items);
      });
  }, [selected, epochs]);

  const approve = async (id: number) => {
    setBusy(true);
    setNotice('');
    try {
      await api.post(`/api/admin/manager/epochs/${id}/approve`);
      load();
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setNotice('');
    try {
      await api.post('/api/admin/manager/epochs/run');
      load();
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Control Room</h1>
          <div className="page-sub">
            Live execution, risk limits and payout epochs. Operator clearance only.
          </div>
        </div>
      </div>
      <LiveNetworkPanel />
      {!user?.isAdmin && (
        <Panel title="OPERATOR CLEARANCE REQUIRED">
          <p className="dim" style={{ margin: 0 }}>
            This public view contains delayed aggregate status only. Connect the designated operator wallet to
            inspect balances, transactions, preflight evidence, controls, and audit records.
          </p>
        </Panel>
      )}
      {!user?.isAdmin ? null : <>
      <Panel
        title="CONTROL ROOM // PAPER ECONOMY" sub="demo-credit accounting; real payouts are disabled"
        right={user?.isAdmin ? <button onClick={runNow} disabled={busy}>Close epoch now</button> : undefined}
      >
        <p className="dim">
          Paper bot P&amp;L and holder distributions are historical demo-credit accounting. They cannot access
          the USDG execution wallet or create real payouts. {notice && <span className="red">{notice}</span>}
        </p>
      </Panel>

      <Panel title="Epochs" noPad>
        <table>
          <thead>
            <tr>
              <th>#</th><th>period</th><th className="num">profit</th>
              <th className="num">holders</th><th>status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {epochs.length === 0 && (
              <tr><td colSpan={6} className="dim">no epochs yet — the manager closes one daily</td></tr>
            )}
            {epochs.map((e) => (
              <tr key={e.id} onClick={() => setSelected(e.id)} style={{ cursor: 'pointer' }}>
                <td className={selected === e.id ? 'green' : ''}>{e.id}</td>
                <td className="dim">{fmtDate(e.periodStart)} → {fmtDate(e.periodEnd)}</td>
                <td className="num green">${fmtUsd(e.totalProfitUsd)}</td>
                <td className="num">{e.eligibleHolders}</td>
                <td><span className={`epoch-status st-${e.status}`}>{e.status}</span></td>
                <td>
                  {user?.isAdmin && e.status === 'needs_review' && (
                    <button className="primary" disabled={busy} onClick={(ev) => { ev.stopPropagation(); void approve(e.id); }}>
                      approve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {detail && (
        <>
          {detail.claudeSummary && (
            <div className="panel">
              <div className="panel-body">
                <div className="commentary">
                  <div className="commentary-label">AGENT COMMENTARY</div>
                  {detail.claudeSummary}
                  {detail.anomalies && detail.anomalies.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {detail.anomalies.map((a, i) => (
                        <div key={i} className="amber">⚑ {a}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <Panel title={`Epoch ${detail.id} payouts`} noPad>
            <table>
              <thead>
                <tr>
                  <th>address</th><th className="num">balance</th>
                  <th className="num">payout</th><th>status</th><th>tx</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{shortAddr(i.address)}</td>
                    <td className="num">{i.balance.toLocaleString()}</td>
                    <td className="num green">${fmtUsd(i.amountUsd, 4)}</td>
                    <td><span className={`epoch-status st-${i.status === 'sent' ? 'done' : i.status === 'failed' ? 'failed' : 'computed'}`}>{i.status}</span></td>
                    <td className="dim">{i.txSig ? shortAddr(i.txSig) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      <Panel title={`AUDIT LOG ▸ CHAIN ${audit?.chain.ok ? '✓ INTACT' : '✗ BROKEN'}`} term noPad>
        <table>
          <thead>
            <tr><th>time</th><th>actor</th><th>action</th><th>hash</th></tr>
          </thead>
          <tbody>
            {(audit?.entries ?? []).map((e) => (
              <tr key={e.id}>
                <td className="dim">{fmtDate(e.ts)}</td>
                <td>{e.actor}</td>
                <td className="cyan">{e.action}</td>
                <td className="dim">{String(e.hash).slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      </>}
    </div>
  );
}
