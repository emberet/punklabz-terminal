import { api } from './api';

// EVM WALLET HANDSHAKE.
//
// PunkLabz runs on Robinhood Chain, so identity is an EVM address proved with
// a personal_sign over a server-issued single-use nonce. This is a SIGNATURE,
// not a transaction: it costs nothing, moves nothing, and grants no spending
// authority. The wallet's own dialog says as much, and the message we ask it
// to sign says so too.
//
// Two ways in, same handshake behind both:
//   injected      — MetaMask/Rabby/Coinbase extension in this browser
//   walletconnect — QR code or deep link to a wallet on your phone

export const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_CHAIN_ID_HEX = '0x1237';
const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';

// A WalletConnect project id is a PUBLIC identifier. It is compiled into this
// bundle and readable by anyone who opens devtools — that is by design; it
// identifies the dapp to the relay and carries no authority. Hardcoding the
// default keeps it out of the server .env, which is where the secrets live and
// which the deploy deliberately never overwrites.
const WALLETCONNECT_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '4fd5c9352f76b3b1dd20799c35cdbe2e';

export type ConnectorKind = 'injected' | 'walletconnect';

const CONNECTOR_KEY = 'plz.connector';

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
}

let active: { kind: ConnectorKind; provider: Eip1193Provider } | null = null;
/** in-flight init, so two clicks cannot open two WalletConnect sessions */
let connecting: Promise<Eip1193Provider> | null = null;
/**
 * The WalletConnect provider is built ONCE and kept.
 *
 * `EthereumProvider.init()` opens a relay socket and subscribes to a pairing
 * topic. Closing the QR modal rejects the connect promise but leaves that
 * machinery alive, so calling init() again on every retry stacks up sockets
 * and subscriptions that nothing ever closes. Users retry — they close the
 * modal to switch wallets, or scan late. Reuse the instance.
 */
let wcProvider: Eip1193Provider | null = null;

function injectedProvider(): Eip1193Provider | null {
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

/** The provider currently in use, falling back to the injected one. */
export function getProvider(): Eip1193Provider | null {
  return active?.provider ?? injectedProvider();
}

/** Is there a browser extension wallet? WalletConnect does not need one. */
export function hasWallet(): boolean {
  return injectedProvider() !== null;
}

export function activeConnector(): ConnectorKind | null {
  return active?.kind ?? null;
}

export class WalletError extends Error {}

async function walletConnectProvider(): Promise<Eip1193Provider> {
  if (wcProvider) return wcProvider;
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  // REQUIRED vs OPTIONAL CHAINS IS THE WHOLE GAME HERE.
  //
  // Robinhood Chain is new, and a WalletConnect session fails outright if the
  // wallet cannot serve a *required* chain. Demanding 4663 would therefore
  // reject nearly every phone wallet in existence today, before the user got
  // as far as the QR code.
  //
  // We do not need it. personal_sign is chain-agnostic, and every balance on
  // this site is read from 4663 by our own server regardless of where the
  // wallet thinks it is. So we require mainnet — which every wallet has — and
  // merely offer 4663.
  const provider = await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [1],
    optionalChains: [ROBINHOOD_CHAIN_ID, 8453, 42161],
    rpcMap: { 1: 'https://eth.llamarpc.com', [ROBINHOOD_CHAIN_ID]: ROBINHOOD_RPC },
    showQrModal: true,
    metadata: {
      name: 'PunkLabz Terminal',
      description: 'Autonomous market research system',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.svg`],
    },
  });
  wcProvider = provider as unknown as Eip1193Provider;
  return wcProvider;
}

/** Bring up a connector and make it the active one. */
async function useConnector(kind: ConnectorKind): Promise<Eip1193Provider> {
  if (active?.kind === kind) return active.provider;
  if (connecting) return connecting;

  connecting = (async () => {
    if (kind === 'injected') {
      const p = injectedProvider();
      if (!p) {
        throw new WalletError(
          'no EVM wallet detected in this browser — install MetaMask or Rabby, use WalletConnect with your phone, or sign in with email',
        );
      }
      active = { kind, provider: p };
      return p;
    }
    let p: Eip1193Provider;
    try {
      p = await walletConnectProvider();
    } catch (e) {
      throw new WalletError(`WalletConnect failed to start: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
    }
    active = { kind, provider: p };
    return p;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Restore a WalletConnect session left over from a previous visit, without
 * opening the QR modal. Injected wallets need no restoring — the extension is
 * either there or it is not.
 */
export async function restoreConnector(): Promise<void> {
  if (active) return;
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(CONNECTOR_KEY);
  } catch {
    return; // storage blocked; treat as nothing to restore
  }
  if (remembered !== 'walletconnect') return;
  try {
    const provider = await walletConnectProvider();
    // init() rehydrates a live session if one exists; no session means no
    // accounts, and we leave `active` unset rather than pretend otherwise
    const accounts = (provider as unknown as { accounts?: string[] }).accounts;
    if (accounts?.length) active = { kind: 'walletconnect', provider };
  } catch {
    /* a stale session is not an error worth showing anyone */
  }
}

function remember(kind: ConnectorKind): void {
  try {
    localStorage.setItem(CONNECTOR_KEY, kind);
  } catch {
    /* private mode; the session simply will not survive a reload */
  }
}

/** Ask for the account. Rejection here is a user decision, not a failure. */
export async function requestAccount(kind: ConnectorKind = 'injected'): Promise<string> {
  const provider = await useConnector(kind);
  let accounts: string[];
  try {
    if (kind === 'walletconnect') {
      // enable() shows the QR/deep-link modal and resolves with the accounts
      accounts = (await (provider as unknown as { enable(): Promise<string[]> }).enable()) as string[];
    } else {
      accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    }
  } catch (e) {
    active = null;
    const code = (e as { code?: number }).code;
    const msg = String((e as Error)?.message ?? e);
    // "Connection request reset" is what WalletConnect throws when the user
    // closes the QR modal. That is a decision, not a fault, and it should not
    // be dressed up as one.
    if (code === 4001 || /reject|denied|closed|request reset/i.test(msg)) {
      throw new WalletError('connection cancelled — nothing was signed');
    }
    throw new WalletError(msg.slice(0, 160));
  }
  if (!accounts?.length) {
    active = null;
    throw new WalletError('wallet returned no account');
  }
  remember(kind);
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
    const hex = (await provider.request({ method: 'eth_chainId' })) as string | number;
    return typeof hex === 'number' ? hex : Number.parseInt(hex, 16);
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
          rpcUrls: [ROBINHOOD_RPC],
          blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
        }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Drop the wallet-side session. Without this a WalletConnect pairing stays
 * live on the user's phone after they disconnect here, which reads as us still
 * holding something we do not.
 */
export async function disconnectProvider(): Promise<void> {
  try {
    await active?.provider.disconnect?.();
  } catch {
    /* already gone */
  }
  active = null;
  try {
    localStorage.removeItem(CONNECTOR_KEY);
  } catch {
    /* nothing to clear */
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
    const msg = String((e as Error)?.message ?? e);
    if ((e as { code?: number }).code === 4001 || /reject|denied/i.test(msg)) {
      throw new WalletError('signature declined');
    }
    throw new WalletError(msg.slice(0, 160));
  }
}

/** Sign in with a wallet, creating the account if this is its first sight. */
export async function walletSignIn(kind: ConnectorKind = 'injected'): Promise<{ address: string }> {
  const address = await requestAccount(kind);
  const signature = await signNonce(address);
  await api.post('/api/auth/wallet/verify', { address, signature });
  return { address };
}

/** Attach a wallet to the account already signed in. */
export async function walletConnectToAccount(
  kind: ConnectorKind = 'injected',
): Promise<{ address: string; isAdmin: boolean }> {
  const address = await requestAccount(kind);
  const signature = await signNonce(address);
  const res = await api.post<{ walletAddress: string; isAdmin: boolean }>(
    '/api/auth/wallet/link',
    { address, signature },
  );
  return { address: res.walletAddress, isAdmin: res.isAdmin };
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
