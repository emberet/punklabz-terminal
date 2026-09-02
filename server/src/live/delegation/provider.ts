import { existsSync, readFileSync } from 'node:fs';
import { getAddress } from 'viem';

const PRIVY_API = 'https://api.privy.io/v1';

export interface SessionSignerBinding {
  sessionSignerId: string;
  policyId: string | null;
  walletAddress: string;
  chainId: number;
}

export interface ProviderReadiness {
  ready: boolean;
  detail: string;
}

export interface DelegationProvider {
  readonly kind: string;
  isReady(): Promise<ProviderReadiness>;
  provisioningConfig(): Promise<{ signerId: string; policyId: string } | null>;
  verifySessionSigner(args: {
    providerUserId: string;
    providerWalletId?: string;
    walletAddress: string;
    chainId: number;
    sessionSignerId: string;
  }): Promise<SessionSignerBinding>;
  applyPolicy(args: {
    sessionSignerId: string;
    perTradeUsd: number;
    dailyUsd: number;
    cumulativeUsd: number;
    allowedTokens: string[];
    expiresAt: number;
  }): Promise<{ policyId: string }>;
  revokeSessionSigner(sessionSignerId: string): Promise<void>;
}

export class NullDelegationProvider implements DelegationProvider {
  readonly kind = 'none';

  async isReady(): Promise<ProviderReadiness> {
    return {
      ready: false,
      detail:
        'no delegation provider configured — set DELEGATION_PROVIDER and supply the ' +
        'embedded-wallet credentials. PunkLabz never holds user key material itself.',
    };
  }

  async provisioningConfig(): Promise<null> {
    return null;
  }

  async verifySessionSigner(): Promise<SessionSignerBinding> {
    throw new Error('NullDelegationProvider: cannot verify a session signer — no provider configured');
  }

  async applyPolicy(): Promise<{ policyId: string }> {
    throw new Error('NullDelegationProvider: cannot apply a spending policy — no provider configured');
  }

  async revokeSessionSigner(): Promise<void> {
    // Local revocation always succeeds even if no provider exists.
  }
}

interface PrivyDelegationConfig {
  appId: string;
  appSecret: string;
  authorizationKeyPresent: boolean;
  signerId: string;
  policyId: string;
}

export class PrivyDelegationProvider implements DelegationProvider {
  readonly kind = 'privy';
  private lastVerifiedSigner: string | null = null;

  constructor(private readonly cfg: PrivyDelegationConfig) {}

  private async get(path: string): Promise<any> {
    const response = await fetch(`${PRIVY_API}${path}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString('base64')}`,
        'privy-app-id': this.cfg.appId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Privy read-back returned HTTP ${response.status}`);
    return response.json();
  }

  async isReady(): Promise<ProviderReadiness> {
    if (!this.cfg.appId || !this.cfg.appSecret || !this.cfg.authorizationKeyPresent
      || !this.cfg.signerId || !this.cfg.policyId) {
      return { ready: false, detail: 'Privy user-wallet signer, reviewed policy, authorization key, or app credentials are missing' };
    }
    try {
      const [signer, policy] = await Promise.all([
        this.get(`/key_quorums/${encodeURIComponent(this.cfg.signerId)}`),
        this.get(`/policies/${encodeURIComponent(this.cfg.policyId)}`),
      ]);
      if (signer?.id !== this.cfg.signerId || policy?.id !== this.cfg.policyId) {
        return { ready: false, detail: 'Privy signer/policy read-back did not match configured IDs' };
      }
      return { ready: true, detail: 'Privy signer and reviewed crypto-only policy verified by read-back' };
    } catch (error) {
      return { ready: false, detail: String(error instanceof Error ? error.message : error).slice(0, 180) };
    }
  }

  async provisioningConfig(): Promise<{ signerId: string; policyId: string } | null> {
    const readiness = await this.isReady();
    return readiness.ready ? { signerId: this.cfg.signerId, policyId: this.cfg.policyId } : null;
  }

  async verifySessionSigner(args: {
    providerUserId: string;
    providerWalletId?: string;
    walletAddress: string;
    chainId: number;
    sessionSignerId: string;
  }): Promise<SessionSignerBinding> {
    if (args.chainId !== 4663) throw new Error('user bot wallet must be bound to Robinhood Chain 4663');
    if (!args.providerWalletId) throw new Error('Privy wallet ID is required for signer read-back');
    if (args.sessionSignerId !== this.cfg.signerId) throw new Error('session signer is not the reviewed PunkLabz user-bot signer');
    const wallet = await this.get(`/wallets/${encodeURIComponent(args.providerWalletId)}`);
    const expectedAddress = getAddress(args.walletAddress).toLowerCase();
    if (String(wallet?.address ?? '').toLowerCase() !== expectedAddress || wallet?.chain_type !== 'ethereum') {
      throw new Error('Privy wallet read-back does not match the requested EVM wallet');
    }
    if (String(wallet?.owner_id ?? '') !== args.providerUserId) {
      throw new Error('Privy wallet owner does not match the authenticated provider user');
    }
    const signer = (wallet?.additional_signers ?? []).find((item: any) => item?.signer_id === this.cfg.signerId);
    const policies = [...(signer?.override_policy_ids ?? [])].sort();
    if (!signer || policies.length !== 1 || policies[0] !== this.cfg.policyId) {
      throw new Error('Privy wallet does not enforce the exact reviewed signer policy');
    }
    this.lastVerifiedSigner = args.sessionSignerId;
    return {
      sessionSignerId: args.sessionSignerId,
      policyId: this.cfg.policyId,
      walletAddress: expectedAddress,
      chainId: 4663,
    };
  }

  async applyPolicy(args: { sessionSignerId: string }): Promise<{ policyId: string }> {
    if (this.lastVerifiedSigner !== args.sessionSignerId) {
      throw new Error('Privy signer policy was not verified in this activation');
    }
    return { policyId: this.cfg.policyId };
  }

  async revokeSessionSigner(): Promise<void> {
    // The wallet owner must remove the signer in their Privy session. Throw so
    // audit never falsely claims provider-side authority was removed.
    throw new Error('user-owned Privy signer removal requires the wallet owner');
  }
}

function fileSecret(name: string): string {
  const path = process.env[name];
  return path && existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

export function buildDelegationProvider(): DelegationProvider {
  const provider = process.env.DELEGATION_PROVIDER ?? 'none';
  if (provider === 'none') return new NullDelegationProvider();
  if (provider !== 'privy') throw new Error(`unsupported DELEGATION_PROVIDER=${provider}`);
  const production = process.env.NODE_ENV === 'production';
  if (production && process.env.PRIVY_APP_SECRET) {
    throw new Error('PRIVY_APP_SECRET is forbidden in production; use PRIVY_APP_SECRET_FILE');
  }
  if (production && process.env.PRIVY_AUTHORIZATION_KEY) {
    throw new Error('PRIVY_AUTHORIZATION_KEY is forbidden in production; use PRIVY_AUTHORIZATION_KEY_FILE');
  }
  const appSecret = fileSecret('PRIVY_APP_SECRET_FILE') || (!production ? process.env.PRIVY_APP_SECRET ?? '' : '');
  const authorizationKey = fileSecret('PRIVY_AUTHORIZATION_KEY_FILE')
    || (!production ? process.env.PRIVY_AUTHORIZATION_KEY ?? '' : '');
  return new PrivyDelegationProvider({
    appId: process.env.PRIVY_APP_ID ?? '', appSecret,
    authorizationKeyPresent: authorizationKey.length > 0,
    signerId: process.env.PRIVY_USER_BOT_SIGNER_ID ?? '',
    policyId: process.env.PRIVY_USER_BOT_POLICY_ID ?? '',
  });
}
