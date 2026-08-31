// The delegation provider boundary (Privy, or another embedded-wallet service).
//
// The provider holds the user's key material and enforces a policy with the
// same caps we do. PunkLabz receives only an opaque session-signer handle. This
// file ships NullDelegationProvider only — the real client is written by the
// operator against their own Privy app credentials, and its policy must mirror
// the caps here so a bug on our side still cannot spend past what the user
// authorised.

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
  /** confirm the handle the browser produced really binds this wallet */
  verifySessionSigner(args: {
    providerUserId: string;
    walletAddress: string;
    chainId: number;
    sessionSignerId: string;
  }): Promise<SessionSignerBinding>;
  /** mirror the user's caps into a provider-side policy */
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

  async verifySessionSigner(): Promise<SessionSignerBinding> {
    throw new Error('NullDelegationProvider: cannot verify a session signer — no provider configured');
  }

  async applyPolicy(): Promise<{ policyId: string }> {
    throw new Error('NullDelegationProvider: cannot apply a spending policy — no provider configured');
  }

  async revokeSessionSigner(): Promise<void> {
    // A revoke with no provider is a no-op rather than an error: local
    // revocation must always succeed, even when the provider is unreachable.
  }
}

export function buildDelegationProvider(): DelegationProvider {
  const provider = process.env.DELEGATION_PROVIDER ?? 'none';
  if (provider === 'none') return new NullDelegationProvider();
  throw new Error(
    `DELEGATION_PROVIDER=${provider} is not implemented in this build. ` +
      'Implement DelegationProvider against your embedded-wallet service, and mirror the ' +
      'same caps into its own policy engine before enabling delegation.',
  );
}
