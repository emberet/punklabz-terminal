export interface WalletConnectNamespace {
  accounts?: string[];
  chains?: string[];
  methods?: string[];
}

export interface WalletConnectSession {
  namespaces?: Record<string, WalletConnectNamespace>;
}

export interface WalletConnectAccount {
  chainId: number;
  address: string;
}

const ACCOUNT_ID = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/;

/**
 * Select an account on a chain the WalletConnect session actually approved.
 * The provider's persisted chain id is only a preference: it can outlive the
 * session namespace and must never be used as proof of authorization.
 */
export function selectWalletConnectAccount(
  session: WalletConnectSession | undefined,
  persistedChainId: number | undefined,
  preferredChainIds: number[] = [],
): WalletConnectAccount | null {
  const candidates: WalletConnectAccount[] = [];

  for (const [namespaceKey, namespace] of Object.entries(session?.namespaces ?? {})) {
    if (namespaceKey !== 'eip155' && !namespaceKey.startsWith('eip155:')) continue;
    if (!namespace.methods?.includes('personal_sign')) continue;

    for (const account of namespace.accounts ?? []) {
      const match = ACCOUNT_ID.exec(account);
      if (!match) continue;
      candidates.push({ chainId: Number(match[1]), address: match[2] });
    }
  }

  if (!candidates.length) return null;

  const priorities = [persistedChainId, ...preferredChainIds].filter(
    (chainId): chainId is number => Number.isSafeInteger(chainId) && chainId! > 0,
  );
  for (const chainId of priorities) {
    const candidate = candidates.find((account) => account.chainId === chainId);
    if (candidate) return candidate;
  }
  return candidates[0];
}
