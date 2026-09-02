/// <reference types="vite/client" />

// Only the variables this app actually reads are declared, so a typo in a
// VITE_ name is a compile error rather than a silent `undefined` at runtime.
interface ImportMetaEnv {
  /**
   * Optional override for the WalletConnect project id. Public by design — it
   * ships in the client bundle either way. The default lives in lib/wallet.ts.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Public Privy application identifier; no wallet authority or secret. */
  readonly VITE_PRIVY_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
