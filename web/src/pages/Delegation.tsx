import { useCallback, useEffect, useState } from 'react';
import { Panel } from '../components/Panel';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Caps {
  perTradeUsd: number;
  dailyUsd: number;
  cumulativeUsd: number;
  maxOpenNotionalUsd: number;
  maxSlippageBps: number;
}

interface Ceiling {
  tier: number;
  perTradeUsd: number;
  dailyUsd: number;
  cumulativeUsd: number;
  maxGrantsPerUser: number;
  maxTotalDelegatedUsd: number;
  externallyAudited: boolean;
  blockers: string[];
}

interface CeilingView {
  ceiling: Ceiling;
  tiers: { tier: number; perTradeUsd: number; cumulativeUsd: number; requires: string }[];
  provider: { kind: string; ready: boolean; detail: string };
  consentText: string;
  open: boolean;
}

interface Grant {
  id: number;
  botName: string | null;
  walletAddress: string;
  chainId: number;
  status: string;
  caps: Caps;
  ceilingTier: number;
  spentUsd: number;
  spentTodayUsd: number;
  reservedUsd: number;
  headroomUsd: number;
  expiresAt: number;
  providerBound: boolean;
  revokeReason: string | null;
}

interface PreflightCheck { name: string; pass: boolean; detail: string; blocking: boolean }

const usd = (n: number) => `$${n.toFixed(2)}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATUS_TONE: Record<string, string> = {
  active: 'phos', pending: 'soft', paused: 'soft',
  revoked: 'red', expired: 'red', exhausted: 'red',
};

export function Delegation() {
  const { user } = useAuth();
  const [view, setView] = useState<CeilingView | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [preflight, setPreflight] = useState<PreflightCheck[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [caps, setCaps] = useState<Caps>({
    perTradeUsd: 5, dailyUsd: 10, cumulativeUsd: 25,
    maxOpenNotionalUsd: 25, maxSlippageBps: 50,
  });
  const [applied, setApplied] = useState<{ applied: Caps; clampedFields: string[] } | null>(null);

  const load = useCallback(() => {
    api.get<CeilingView>('/api/delegation/ceiling').then(setView).catch(() => {});
    if (user) {
      api.get<{ grants: Grant[] }>('/api/delegation/grants').then((r) => setGrants(r.grants)).catch(() => {});
      api.get<{ checks: PreflightCheck[] }>('/api/delegation/preflight')
        .then((r) => setPreflight(r.checks)).catch(() => {});
    }
  }, [user]);

  useEffect(load, [load]);

  // preview on every change: the number that applies is never a surprise
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.post<{ applied: Caps; clampedFields: string[] }>('/api/delegation/preview', { caps })
      .then((r) => { if (!cancelled) setApplied(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [caps, user]);

  const revoke = async (id: number) => {
    setBusy(id);
    try {
      const r = await api.post<{ inFlightCancelled: number; unstoppable: number[]; detail: string }>(
        `/api/delegation/grants/${id}/revoke`,
      );
      setNotice(
        r.unstoppable.length
          ? `Authority withdrawn. ${r.inFlightCancelled} order(s) cancelled. ` +
            `${r.unstoppable.length} order(s) were already at the venue and cannot be recalled — ` +
            `they will settle and appear in your ledger.`
          : `Authority withdrawn. ${r.detail}`,
      );
      load();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  const setPaused = async (id: number, paused: boolean) => {
    setBusy(id);
    try {
      await api.post(`/api/delegation/grants/${id}/pause`, { paused });
      load();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  if (!view) return <div className="dim">reading the delegation ceiling…</div>;

  const c = view.ceiling;
  const clamped = new Set(applied?.clampedFields ?? []);

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <div className="page-title">Delegation</div>
          <div className="page-sub">
            let a machine trade your wallet · PunkLabz never holds your key and never holds your funds
          </div>
        </div>
      </div>

      {notice && (
        <Panel title="NOTICE" noPad>
          <div className="panel-body">
            <div className="phos">{notice}</div>
            <a style={{ cursor: 'pointer' }} onClick={() => setNotice(null)}>dismiss</a>
          </div>
        </Panel>
      )}

      <Panel
        title="SYSTEM CEILING"
        sub={c.tier === 0 ? 'delegation is closed' : `tier ${c.tier} in force`}
        noPad
      >
        <div className="panel-body">
          <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
            <div>
              <div className="soft">MAX PER TRADE</div>
              <div className={c.perTradeUsd > 0 ? 'phos' : 'red'} style={{ fontSize: 20 }}>
                {usd(c.perTradeUsd)}
              </div>
            </div>
            <div>
              <div className="soft">MAX LIFETIME</div>
              <div className={c.cumulativeUsd > 0 ? 'phos' : 'red'} style={{ fontSize: 20 }}>
                {usd(c.cumulativeUsd)}
              </div>
            </div>
            <div>
              <div className="soft">GRANTS PER OPERATOR</div>
              <div style={{ fontSize: 20 }}>{c.maxGrantsPerUser}</div>
            </div>
          </div>

          {c.tier === 0 && (
            <div className="red" style={{ marginBottom: 8 }}>
              Tier 0. This network has no live track record, so the amount it is allowed to move on
              anyone's behalf is exactly $0. The machinery below is built and testable; it will not
              spend a cent until the ceiling rises, and the ceiling rises only on measured evidence.
            </div>
          )}

          {c.blockers.length > 0 && (
            <>
              <div className="soft" style={{ marginTop: 6 }}>OUTSTANDING FOR THE NEXT TIER</div>
              <ul style={{ margin: '4px 0 0 16px' }}>
                {c.blockers.map((b) => <li key={b} className="soft">{b}</li>)}
              </ul>
            </>
          )}
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>tier</th>
                <th className="num">per trade</th>
                <th className="num">lifetime</th>
                <th>earned by</th>
              </tr>
            </thead>
            <tbody>
              {view.tiers.map((t) => (
                <tr key={t.tier} style={t.tier === c.tier ? { background: 'var(--bg-raised)' } : undefined}>
                  <td className={t.tier === c.tier ? 'phos' : 'soft'}>
                    {t.tier === c.tier ? `▸ ${t.tier}` : t.tier}
                  </td>
                  <td className="num">{usd(t.perTradeUsd)}</td>
                  <td className="num">{usd(t.cumulativeUsd)}</td>
                  <td className="soft">{t.requires}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="CUSTODY" sub="where your money actually sits" noPad>
        <div className="panel-body">
          <div className="row" style={{ gap: 10, marginBottom: 6 }}>
            <span className="soft" style={{ width: 150 }}>KEY MATERIAL</span>
            <span>held by your wallet provider — never by PunkLabz, in any form</span>
          </div>
          <div className="row" style={{ gap: 10, marginBottom: 6 }}>
            <span className="soft" style={{ width: 150 }}>FUNDS</span>
            <span>stay in your wallet. Nothing is pooled, deposited or transferred to us.</span>
          </div>
          <div className="row" style={{ gap: 10, marginBottom: 6 }}>
            <span className="soft" style={{ width: 150 }}>WHAT WE STORE</span>
            <span>your public address, an opaque session handle, and the caps you chose</span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <span className="soft" style={{ width: 150 }}>PROVIDER</span>
            <span className={view.provider.ready ? 'phos' : 'red'}>
              {view.provider.kind} — {view.provider.detail}
            </span>
          </div>
        </div>
      </Panel>

      {preflight && (
        <Panel title="DELEGATION PREFLIGHT" sub="every prerequisite, with its real answer" noPad>
          <div
            className="panel-body"
            style={{ display: 'grid', gridTemplateColumns: 'max-content 4ch 1fr', gap: '2px 12px' }}
          >
            {preflight.map((p) => (
              <div key={p.name} style={{ display: 'contents' }}>
                <span className="soft" style={{ whiteSpace: 'nowrap' }}>{p.name.toUpperCase()}</span>
                <span className={p.pass ? 'phos' : p.blocking ? 'red' : 'soft'}>
                  {p.pass ? 'PASS' : p.blocking ? 'FAIL' : 'WARN'}
                </span>
                <span className="soft">{p.detail}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        title="YOUR LIMITS"
        sub="you choose these — the ceiling above is the only thing that can lower them"
        noPad
      >
        <div className="panel-body">
          {([
            ['perTradeUsd', 'MAX PER TRADE', '$'],
            ['dailyUsd', 'MAX PER DAY', '$'],
            ['cumulativeUsd', 'MAX LIFETIME', '$'],
            ['maxOpenNotionalUsd', 'MAX OPEN AT ONCE', '$'],
            ['maxSlippageBps', 'MAX SLIPPAGE', 'bps'],
          ] as const).map(([key, label, unit]) => (
            <div className="row" style={{ gap: 10, marginBottom: 6 }} key={key}>
              <label className="soft" style={{ width: 170 }} htmlFor={`cap-${key}`}>{label}</label>
              <input
                id={`cap-${key}`}
                type="number"
                min={0}
                value={caps[key]}
                onChange={(e) => setCaps({ ...caps, [key]: Number(e.target.value) })}
                style={{ width: 110 }}
              />
              <span className="soft">{unit}</span>
              {applied && (
                <span className={clamped.has(key) ? 'red' : 'soft'}>
                  {clamped.has(key)
                    ? `→ applies as ${unit === '$' ? usd(applied.applied[key]) : applied.applied[key]} (ceiling)`
                    : 'applies as typed'}
                </span>
              )}
            </div>
          ))}

          {clamped.size > 0 && (
            <div className="red" style={{ marginTop: 6 }}>
              The highlighted limits are above what this network has earned the right to move.
              Your number is kept on record; the smaller one is what would actually apply.
            </div>
          )}
        </div>
      </Panel>

      <Panel title="WHAT YOU WOULD BE SIGNING" noPad>
        <div className="panel-body">
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }} className="soft">{view.consentText}</pre>
        </div>
      </Panel>

      <Panel
        title="YOUR GRANTS"
        sub={grants.length ? `${grants.length} on record` : 'none yet'}
        noPad
      >
        {!user && <div className="panel-body dim">connect an operator account to hold a grant</div>}
        {user && grants.length === 0 && (
          <div className="panel-body dim">
            {view.open
              ? 'no grants yet'
              : 'no grants — and none can be created while the ceiling is at tier 0'}
          </div>
        )}
        {grants.map((g) => (
          <div className="panel-body" key={g.id} style={{ borderTop: '1px solid var(--border)' }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <span className="phos">{g.botName ?? `machine #${g.id}`}</span>
              <span className="soft">{shortAddr(g.walletAddress)}</span>
              <span className="soft">chain {g.chainId}</span>
              <span className={STATUS_TONE[g.status] ?? 'soft'}>{g.status.toUpperCase()}</span>
              {!g.providerBound && <span className="soft">no signer bound</span>}
            </div>
            <div className="row" style={{ gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
              <span className="soft">headroom <span className="phos">{usd(g.headroomUsd)}</span></span>
              <span className="soft">today {usd(g.spentTodayUsd)} / {usd(g.caps.dailyUsd)}</span>
              <span className="soft">lifetime {usd(g.spentUsd)} / {usd(g.caps.cumulativeUsd)}</span>
              <span className="soft">expires {new Date(g.expiresAt).toISOString().slice(0, 10)}</span>
            </div>
            {g.revokeReason && <div className="soft" style={{ marginTop: 4 }}>{g.revokeReason}</div>}
            <div className="row" style={{ gap: 10, marginTop: 8 }}>
              {(g.status === 'active' || g.status === 'paused') && (
                <button disabled={busy === g.id} onClick={() => void setPaused(g.id, g.status === 'active')}>
                  {g.status === 'active' ? 'PAUSE' : 'RESUME'}
                </button>
              )}
              {g.status !== 'revoked' && g.status !== 'expired' && (
                <button className="danger" disabled={busy === g.id} onClick={() => void revoke(g.id)}>
                  REVOKE NOW
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="panel-body soft" style={{ borderTop: '1px solid var(--border)' }}>
          Revocation is instant and needs nobody's approval. An order already submitted to a venue
          cannot be recalled — you will be told exactly how many, if any.
        </div>
      </Panel>
    </div>
  );
}
