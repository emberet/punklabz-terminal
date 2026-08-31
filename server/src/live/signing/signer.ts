// The signing boundary.
//
// PunkLabz holds a PUBLIC ADDRESS and a reference to a signing service. It must
// never hold key material: not in .env, not in SQLite, not in a log line, not
// in the client bundle. A key that transits this process is a key you have to
// assume is compromised.
//
// The interface below is the contract a real signer must satisfy. This file
// deliberately ships only NoSigner. Implementing a signer that can actually
// move funds is an operator task performed against a hardware-backed or
// hosted signing service (Turnkey, Fireblocks, Privy, an internal HSM), with
// its own auth, its own audit trail, and a spending policy that is enforced on
// the signer side as well as here — so a bug in PunkLabz cannot drain a wallet.

import { PrivySigner, privyConfigFromEnv } from './privySigner.js';

export interface SignRequest {
  chainId: number;
  to: string;
  data: string;
  value: bigint;
  gas?: bigint;
  /**
   * Nonce and fees are supplied BY THE CALLER, not left to the signing service.
   *
   * Privy fills anything omitted with zero. A transaction offering zero gas
   * price is perfectly valid and never mined, so the failure is not an error
   * anywhere — it is an order that sits pending forever while the ledger
   * believes it was submitted. The caller knows the chain; it supplies these.
   */
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** the order intent this signature belongs to — signers should refuse duplicates */
  intentId: string;
}

export interface TradingSigner {
  readonly kind: string;
  /** public address only */
  getAddress(): Promise<string | null>;
  isReady(): Promise<SignerReadiness>;
  signTransaction(req: SignRequest): Promise<string>;
}

export interface SignerReadiness {
  ready: boolean;
  address: string | null;
  detail: string;
}

/**
 * The only signer in this build. Reports honestly that nothing can be signed,
 * which is what makes the live preflight fail closed.
 */
export class NoSigner implements TradingSigner {
  readonly kind = 'none';

  async getAddress(): Promise<string | null> {
    return null;
  }

  async isReady(): Promise<SignerReadiness> {
    return {
      ready: false,
      address: null,
      detail:
        'no signing service configured — set SIGNER_PROVIDER and point it at an external ' +
        'signer that holds the key material. PunkLabz never stores keys itself.',
    };
  }

  async signTransaction(): Promise<string> {
    throw new Error('NoSigner: refusing to sign — no signing service is configured');
  }
}

/** Resolve the signer from config. */
export function buildSigner(): TradingSigner {
  const provider = process.env.SIGNER_PROVIDER ?? 'none';
  if (provider === 'none') return new NoSigner();
  if (provider === 'privy') {
    // Constructed lazily so a missing credential surfaces through isReady()
    // as a readable preflight blocker rather than crashing the boot.
    return new PrivySigner(privyConfigFromEnv());
  }
  throw new Error(
    `SIGNER_PROVIDER=${provider} is not implemented in this build. ` +
      'Implement TradingSigner against your signing service before enabling live execution.',
  );
}
