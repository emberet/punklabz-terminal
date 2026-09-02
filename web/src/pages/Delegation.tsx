import { useCallback, useEffect, useState } from 'react';
import { Panel } from '../components/Panel';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/pageMeta';
import { useCreateWallet, usePrivy, useSigners } from '@privy-io/react-auth';
import { type BotSummary, ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD } from '@punklabz/shared';

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
  botId: number;
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

interface BotWallet {
  botId: number;
  botName: string;
  walletAddress: string;
  chainId: number;
  state: string;
  screeningStatus: string;
  reconciledHoldings: Record<string, number>;
  reconciliation: null | { status: string; completedAt: number | null; detail: string };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATUS_TONE: Record<string, string> = {
  active: 'phos', pending: 'soft', paused: 'soft',
  revoked: 'red', expired: 'red', exhausted: 'red',
};

export function Delegation() {
  usePageMeta('Delegation', 'Let a machine trade your wallet under limits you set and can revoke at any time.');
  const { user } = useAuth();
  const [view, setView] = useState<CeilingView | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [wallets, setWallets] = useState<BotWallet[]>([]);
  const [preflight, setPreflight] = useState<PreflightCheck[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fundingHashes, setFundingHashes] = useState<Record<number, string>>({});

  const [caps, setCaps] = useState<Caps>({
    perTradeUsd: 5, dailyUsd: 10, cumulativeUsd: 25,
    maxOpenNotionalUsd: 25, maxSlippageBps: 35,
  });
  const [applied, setApplied] = useState<{ applied: Caps; clampedFields: string[] } | null>(null);

  const load = useCallback(() => {
    api.get<CeilingView>('/api/delegation/ceiling').then(setView).catch(() => {});
    if (user) {
      api.get<{ grants: Grant[] }>('/api/delegation/grants').then((r) => setGrants(r.grants)).catch(() => {});
      api.get<{ wallets: BotWallet[] }>('/api/delegation/bot-wallets').then((r) => setWallets(r.wallets)).catch(() => {});
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

  const grantAction = async (id: number, action: 'reconcile' | 'withdrawal-check') => {
    setBusy(id);
    setNotice(null);
    try {
      const result = await api.post<any>(`/api/delegation/grants/${id}/${action}`);
      setNotice(action === 'withdrawal-check'
        ? `${result.detail}. Wallet ${shortAddr(result.walletAddress)} is clean for an in-kind withdrawal.`
        : `Reconciliation ${result.reconciliation.status}: ${result.reconciliation.detail}`);
      load();
    } catch (error) {
      setNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(null);
    }
  };

  const importFunding = async (id: number) => {
    const txHash = fundingHashes[id]?.trim();
    if (!txHash) return;
    setBusy(id);
    setNotice(null);
    try {
      const result = await api.post<any>(`/api/delegation/grants/${id}/funding/import`, { txHash });
      setNotice(`Funding verified and reconciled: ${JSON.stringify(result.holdings)}`);
      setFundingHashes((current) => ({ ...current, [id]: '' }));
      load();
    } catch (error) {
      setNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(null);
    }
  };

  const activate = async (id: number) => {
    setBusy(id);
    setNotice(null);
    try {
      const cfg = await api.post<{ signer: { signerId: string } }>('/api/delegation/provisioning-config');
      await api.post(`/api/delegation/grants/${id}/activate`, { sessionSignerId: cfg.signer.signerId });
      setNotice('Bot wallet screened, policy verified, and live delegation activated.');
      load();
    } catch (error) {
      setNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(null);
    }
  };

  if (!view) {
    return (
      <div style={{ maxWidth: 900 }}>
        <div className="page-head">
          <div>
            <h1 className="page-title">Delegation</h1>
            <div className="page-sub">let a machine trade your wallet</div>
          </div>
        </div>
        <div className="dim">reading the delegation ceiling…</div>
      </div>
    );
  }

  const c = view.ceiling;
  const clamped = new Set(applied?.clampedFields ?? []);

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Delegation</h1>
          <div className="page-sub">
            let a machine trade your wallet · PunkLabz never holds your key and never holds your funds
          </div>
        </div>
      </div>

      {notice && (
        <Panel title="NOTICE" noPad>
          <div className="panel-body">
            <div className="phos">{notice}</div>
            <button type="button" className="linkish" onClick={() => setNotice(null)}>dismiss</button>
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

      {user && import.meta.env.VITE_PRIVY_APP_ID && (
        <PrivyBotProvisioner
          open={view.open}
          linked={!!user.hasPrivy}
          caps={applied?.applied ?? caps}
          consentText={view.consentText}
          onNotice={setNotice}
          onComplete={load}
        />
      )}

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
            {(() => {
              const wallet = wallets.find((item) => item.botId === g.botId);
              return wallet ? (
                <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span className="soft">wallet {wallet.state.toUpperCase()}</span>
                  <span className="soft">USDG {Number(wallet.reconciledHoldings.USDG ?? 0).toFixed(6)}</span>
                  <span className="soft">ETH {Number(wallet.reconciledHoldings.ETH ?? 0).toFixed(6)}</span>
                  <span className={wallet.reconciliation?.status === 'clean' ? 'phos' : 'soft'}>
                    RECON {wallet.reconciliation?.status?.toUpperCase() ?? 'NONE'}
                  </span>
                </div>
              ) : null;
            })()}
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
              {g.status === 'pending' && (
                <>
                  <input
                    aria-label="Funding transaction hash"
                    placeholder="0x funding transaction"
                    value={fundingHashes[g.id] ?? ''}
                    onChange={(event) => setFundingHashes((current) => ({ ...current, [g.id]: event.target.value }))}
                    style={{ minWidth: 250 }}
                  />
                  <button disabled={busy === g.id || !fundingHashes[g.id]} onClick={() => void importFunding(g.id)}>
                    IMPORT FUNDING
                  </button>
                  <button disabled={busy === g.id} onClick={() => void grantAction(g.id, 'reconcile')}>RECONCILE</button>
                  <button className="primary" disabled={busy === g.id} onClick={() => void activate(g.id)}>ACTIVATE</button>
                </>
              )}
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
              {['paused', 'revoked', 'expired'].includes(g.status) && (
                <button disabled={busy === g.id} onClick={() => void grantAction(g.id, 'withdrawal-check')}>
                  WITHDRAWAL CHECK
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

function PrivyBotProvisioner({
  open, linked, caps, consentText, onNotice, onComplete,
}: {
  open: boolean;
  linked: boolean;
  caps: Caps;
  consentText: string;
  onNotice: (message: string | null) => void;
  onComplete: () => void;
}) {
  const { ready, authenticated, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { addSigners, removeSigners } = useSigners();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [walletBotIds, setWalletBotIds] = useState<Set<number>>(new Set());
  const [botId, setBotId] = useState<number | ''>('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !linked || !authenticated) return;
    void Promise.all([
      api.get<{ bots: BotSummary[] }>('/api/my/bots?limit=100'),
      api.get<{ wallets: BotWallet[] }>('/api/delegation/bot-wallets'),
    ]).then(([owned, walletRows]) => {
      setBots(owned.bots);
      setWalletBotIds(new Set(walletRows.wallets.map((wallet) => wallet.botId)));
      const next = owned.bots.find((bot) => !walletRows.wallets.some((wallet) => wallet.botId === bot.id));
      setBotId(next?.id ?? '');
    }).catch((error) => onNotice(error.message));
  }, [open, linked, authenticated]);

  const provision = async () => {
    if (!user || !botId || !consent) return;
    setBusy(true);
    onNotice(null);
    let createdAddress: string | null = null;
    let signerAttached = false;
    try {
      const cfg = await api.post<{ signer: { signerId: string; policyId: string } }>(
        '/api/delegation/provisioning-config',
      );
      const hasEmbedded = user.linkedAccounts.some((account) => account.type === 'wallet'
        && (account.walletClientType === 'privy' || account.walletClientType === 'privy-v2'));
      const wallet = await createWallet(hasEmbedded ? { createAdditional: true } : undefined);
      createdAddress = wallet.address;
      const created = await api.post<{ grant: Grant }>('/api/delegation/grants', {
        botId,
        providerUserId: user.id,
        walletAddress: wallet.address,
        chainId: ROBINHOOD_MAINNET_CHAIN_ID,
        caps,
        allowedTokens: [
          { address: WETH_ROBINHOOD.address, symbol: 'WETH', decimals: WETH_ROBINHOOD.decimals, role: 'base' },
          { address: USDG.address, symbol: 'USDG', decimals: USDG.decimals, role: 'quote' },
        ],
        durationDays: 30,
        consentAccepted: true,
      });
      const attached = await addSigners({
        address: wallet.address,
        signers: [{ signerId: cfg.signer.signerId, policyIds: [cfg.signer.policyId] }],
      });
      signerAttached = true;
      const providerWallet = attached.user.linkedAccounts.find((account) => account.type === 'wallet'
        && account.address.toLowerCase() === wallet.address.toLowerCase());
      const providerWalletId = providerWallet && 'id' in providerWallet && typeof providerWallet.id === 'string'
        ? providerWallet.id : null;
      if (!providerWalletId) throw new Error('Privy did not return the delegated wallet ID');
      await api.post(`/api/delegation/grants/${created.grant.id}/provider-wallet`, {
        providerWalletId,
        sessionSignerId: cfg.signer.signerId,
      });
      onNotice(`Isolated wallet ${shortAddr(wallet.address)} is recorded. Fund it with USDG and at least 0.005 ETH.`);
      setConsent(false);
      onComplete();
    } catch (error) {
      if (signerAttached && createdAddress) {
        await removeSigners({ address: createdAddress }).catch(() => undefined);
      }
      onNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };

  const availableBots = bots.filter((bot) => !walletBotIds.has(bot.id));
  return (
    <Panel title="PROVISION LIVE BOT" sub="one isolated Privy wallet per machine" noPad>
      <div className="panel-body">
        {!open ? (
          <div className="red">LOCKED AT DELEGATION TIER 0</div>
        ) : !linked ? (
          <div className="red">LINK PRIVY IDENTITY BEFORE PROVISIONING</div>
        ) : !ready || !authenticated ? (
          <div className="soft">REAUTHENTICATE WITH PRIVY TO CREATE A BOT WALLET</div>
        ) : (
          <>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <select value={botId} onChange={(event) => setBotId(Number(event.target.value) || '')} disabled={busy}>
                <option value="">select paper machine</option>
                {availableBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
              <span className="soft">WETH / USDG · CHAIN 4663 · NO LEVERAGE</span>
            </div>
            <label className="row" style={{ gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span className="soft">I ACCEPT THE DELEGATION CONSENT SHOWN ABOVE.</span>
            </label>
            <button className="primary" style={{ marginTop: 10 }} disabled={busy || !botId || !consent} onClick={() => void provision()}>
              {busy ? 'PROVISIONING…' : 'CREATE ISOLATED BOT WALLET'}
            </button>
            <span className="dim" style={{ marginLeft: 10 }}>{consentText.split('\n')[0]}</span>
          </>
        )}
      </div>
    </Panel>
  );
}
