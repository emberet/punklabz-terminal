import { api } from './api';

// EVM WALLET HANDSHAKE.
//
// PunkLabz runs on Robinhood Chain, so identity is an EVM address proved with
// a personal_sign over a server-issued single-use nonce. This is a SIGNATURE,
// not a transaction: it costs nothing, moves nothing, and grants no spending
// authority. The wallet's own dialog says as much, and the message we ask it
// to sign says so too.

export const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_CHAIN_ID_HEX = '0x1237';

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export function getProvider(): Eip1193Provider | null {
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return injected ?? null;
}

export function hasWallet(): boolean {
  return getProvider() !== null;
}

export class WalletError extends Error {}

/** Ask for the account. Rejection here is a user decision, not a failure. */
export async function requestAccount(): Promise<string> {
  const provider = getProvider();
  if (!provider) {
    throw new WalletError(
      'no EVM wallet detected in this browser — install MetaMask, Rabby or another wallet, or sign in with email',
    );
  }
  let accounts: string[];
  try {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4001) throw new WalletError('wallet connection declined');
    throw new WalletError(String((e as Error)?.message ?? e).slice(0, 160));
  }
  if (!accounts?.length) throw new WalletError('wallet returned no account');
  return accounts[0];
}

/** Currently selected account without prompting, or null. */
export async function currentAccount(): Promise<string | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function currentChainId(): Promise<number | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    const hex = (await provider.request({ method: 'eth_chainId' })) as string;
    return Number.parseInt(hex, 16);
  } catch {
    return null;
  }
}

/**
 * Offer to add/switch to Robinhood Chain. Signing does not require being on
 * the right chain, so this never blocks the handshake — it is a convenience so
 * balances resolve against the network we actually read.
 */
export async function switchToRobinhoodChain(): Promise<boolean> {
  const provider = getProvider();
  if (!provider) return false;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN_ID_HEX }] });
    return true;
  } catch (e) {
    // 4902 = chain unknown to the wallet; offer to add it
    if ((e as { code?: number }).code !== 4902) return false;
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: ROBINHOOD_CHAIN_ID_HEX,
          chainName: 'Robinhood Chain',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
          blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
        }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function signNonce(address: string): Promise<string> {
  const provider = getProvider()!;
  const { message } = await api.get<{ nonce: string; message: string }>(
    `/api/auth/wallet/nonce?address=${encodeURIComponent(address)}`,
  );
  try {
    return (await provider.request({ method: 'personal_sign', params: [message, address] })) as string;
  } catch (e) {
    if ((e as { code?: number }).code === 4001) throw new WalletError('signature declined');
    throw new WalletError(String((e as Error)?.message ?? e).slice(0, 160));
  }
}

/** Sign in with a wallet, creating the account if this is its first sight. */
export async function walletSignIn(): Promise<{ address: string }> {
  const address = await requestAccount();
  const signature = await signNonce(address);
  await api.post('/api/auth/wallet/verify', { address, signature });
  return { address };
}

/** Attach a wallet to the account already signed in. */
export async function walletConnectToAccount(): Promise<{ address: string; isAdmin: boolean }> {
  const address = await requestAccount();
  const signature = await signNonce(address);
  const res = await api.post<{ walletAddress: string; isAdmin: boolean }>(
    '/api/auth/wallet/link',
    { address, signature },
  );
  return { address: res.walletAddress, isAdmin: res.isAdmin };
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
