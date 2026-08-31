import { createSign, createPrivateKey } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import type { SignRequest, SignerReadiness, TradingSigner } from './signer.js';

// PRIVY SERVER WALLET.
//
// PunkLabz holds an app id, a wallet id and a PUBLIC address. The key lives
// inside Privy's enclave and never transits this process — that property is
// the whole reason for using a remote signer, and nothing in this file may
// weaken it.
//
// Three independent limits stand between an agent and the wallet:
//
//   1. PunkLabz risk core   — refuses the intent before a transaction exists
//   2. THIS FILE            — refuses to sign a destination it does not know,
//                             or a native value above the configured ceiling
//   3. Privy's policy engine — refuses server-side, enforced cryptographically
//                             at the enclave, where a bug in our code cannot
//                             reach it
//
// Only the third survives a total compromise of this process, which is why the
// per-transaction cap must be configured in the Privy dashboard as well. The
// checks here catch our own mistakes; they are not the last line.
//
// Wire format verified against Privy's REST documentation:
//   POST https://api.privy.io/v1/wallets/<wallet_id>/rpc
//   Authorization: Basic base64(app_id:app_secret)
//   privy-app-id, privy-authorization-signature, privy-idempotency-key
//   { method, caip2: "eip155:<chainId>", params: { transaction: {...} } }

const PRIVY_API = 'https://api.privy.io/v1';

export interface PrivyConfig {
  appId: string;
  appSecret: string;
  walletId: string;
  /** the address we EXPECT; verified against Privy at startup, never assumed */
  expectedAddress: string;
  /** PKCS8 P-256 private key, base64. Optional but strongly recommended. */
  authorizationKey?: string;
  /** contracts this wallet may ever be asked to call */
  allowedTargets: string[];
  /** hard ceiling on NATIVE value per transaction, in wei */
  maxNativeValueWei: bigint;
}

/**
 * Privy hands out authorization keys prefixed with `wallet-auth:`, e.g.
 * `wallet-auth:MIGHAgEAMBMGByqGSM49...`. The bytes after the prefix are a
 * base64 PKCS8 P-256 key; the prefix itself is not base64 and makes the whole
 * string fail to decode.
 *
 * Normalising in ONE place matters: the same string is consumed by the signer
 * and by the provisioning script, and a prefix handled in only one of them
 * means provisioning succeeds and every subsequent signature fails — or the
 * reverse. Copy the value straight from the dashboard and it works.
 */
export function normalizeAuthorizationKey(raw: string): Buffer {
  const body = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  const der = Buffer.from(body.trim(), 'base64');
  if (der.length === 0 || der[0] !== 0x30) {
    throw new Error('authorization key is not a base64 PKCS8 DER key (expected a DER SEQUENCE)');
  }
  return der;
}

/**
 * RFC 8785 (JCS) canonicalisation, scoped to the value types Privy payloads
 * contain: objects, arrays, strings, integers, booleans, null. Deliberately
 * throws on anything else — a float or a bigint silently serialised the wrong
 * way produces a signature the enclave rejects, and a confusing 401 is a much
 * worse failure than an explicit one.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isInteger(value)) throw new Error('JCS: non-integer number in signing payload');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // JCS sorts by UTF-16 code unit, which is what a plain < comparison does
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new Error(`JCS: unsupported value type ${t} in signing payload`);
}

interface PrivyWallet {
  id: string;
  address: string;
  chain_type?: string;
  /** the authorization key or quorum whose signature Privy requires. null = none. */
  owner_id?: string | null;
  policy_ids?: string[];
}

/** What the enclave is actually enforcing, as opposed to what we configured. */
export interface SignerGuards {
  ownerEnforced: boolean;
  ownerId: string | null;
  policyCount: number;
  /** true only when BOTH walls are real at Privy */
  fullyGuarded: boolean;
}

export class PrivySigner implements TradingSigner {
  readonly kind = 'privy';
  private verifiedAddress: string | null = null;
  private ownerId: string | null = null;
  private policyIds: string[] = [];
  private readonly allowed: Set<string>;

  /** Read after isReady(); drives the blocking preflight check. */
  guards(): SignerGuards {
    return {
      ownerEnforced: !!this.ownerId,
      ownerId: this.ownerId,
      policyCount: this.policyIds.length,
      fullyGuarded: !!this.ownerId && this.policyIds.length > 0,
    };
  }

  constructor(private cfg: PrivyConfig) {
    this.allowed = new Set(cfg.allowedTargets.map((a) => a.toLowerCase()));
  }

  private basicAuth(): string {
    return Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString('base64');
  }

  /**
   * The authorization signature. Signs a canonical form of the whole request —
   * method, url, body and the app-id header — so neither the destination nor
   * the amount can be altered in flight without invalidating it.
   */
  private authorizationSignature(
    method: string,
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): string | null {
    if (!this.cfg.authorizationKey) return null;
    const payload = {
      version: 1,
      method,
      url,
      body,
      headers: { 'privy-app-id': this.cfg.appId, ...extraHeaders },
    };
    const key = createPrivateKey({
      key: normalizeAuthorizationKey(this.cfg.authorizationKey), format: 'der', type: 'pkcs8',
    });
    const signer = createSign('sha256');
    signer.update(Buffer.from(canonicalize(payload), 'utf8'));
    signer.end();
    return signer.sign(key).toString('base64');
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = `${PRIVY_API}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${this.basicAuth()}`,
      'privy-app-id': this.cfg.appId,
      'Content-Type': 'application/json',
    };
    const extra: Record<string, string> = {};
    if (idempotencyKey) {
      headers['privy-idempotency-key'] = idempotencyKey;
      extra['privy-idempotency-key'] = idempotencyKey;
    }
    if (method === 'POST') {
      const signature = this.authorizationSignature(method, url, body ?? {}, extra);
      if (signature) headers['privy-authorization-signature'] = signature;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Never echo the response wholesale — an error body can carry request
      // context. Status plus a bounded excerpt is enough to diagnose.
      throw new Error(`privy ${method} ${path} → ${res.status}: ${text.slice(0, 240)}`);
    }
    return JSON.parse(text) as T;
  }

  async getAddress(): Promise<string | null> {
    if (this.verifiedAddress) return this.verifiedAddress;
    const ready = await this.isReady();
    return ready.address;
  }

  /**
   * Proves the wallet id actually maps to the address we were told, before
   * anything is ever signed. A wallet id copied from a dashboard URL is a
   * guess until something checks it.
   */
  async isReady(): Promise<SignerReadiness> {
    const missing = [
      !this.cfg.appId && 'PRIVY_APP_ID',
      !this.cfg.appSecret && 'PRIVY_APP_SECRET',
      !this.cfg.walletId && 'PRIVY_WALLET_ID',
      !this.cfg.expectedAddress && 'TRADING_WALLET_ADDRESS',
    ].filter(Boolean);
    if (missing.length) {
      return { ready: false, address: null, detail: `privy signer misconfigured — missing ${missing.join(', ')}` };
    }
    if (!isAddress(this.cfg.expectedAddress)) {
      return { ready: false, address: null, detail: `TRADING_WALLET_ADDRESS is not a valid EVM address` };
    }

    try {
      const wallet = await this.call<PrivyWallet>(
        'GET', `/wallets/${encodeURIComponent(this.cfg.walletId)}`,
      );
      if (!wallet?.address || !isAddress(wallet.address)) {
        return { ready: false, address: null, detail: 'privy returned no usable address for that wallet id' };
      }
      const reported = wallet.address.toLowerCase();
      const expected = this.cfg.expectedAddress.toLowerCase();
      if (reported !== expected) {
        // Refusing here is the point: signing with a wallet other than the one
        // funded and policy-capped is how money leaves from somewhere nobody
        // is watching.
        return {
          ready: false,
          address: null,
          detail:
            `WALLET MISMATCH — privy wallet ${this.cfg.walletId} is ${getAddress(wallet.address)}, ` +
            `but TRADING_WALLET_ADDRESS is ${getAddress(this.cfg.expectedAddress)}. Refusing to sign.`,
        };
      }

      // THE SECOND WALL, REPORTED FROM PRIVY AND NOT FROM OUR OWN CONFIG.
      //
      // This previously said "authorization key active" whenever
      // PRIVY_AUTHORIZATION_KEY was merely present in the environment. That is
      // not the same question. The key only enforces anything once it is the
      // wallet's OWNER at Privy — and a wallet can have the env var set and
      // `owner_id: null`, which is exactly the state this deployment was in.
      //
      // A readiness message is what an operator reads when deciding whether it
      // is safe to fund a wallet. Asserting a control that is not in force is
      // worse than saying nothing at all.
      this.ownerId = wallet.owner_id ?? null;
      this.policyIds = wallet.policy_ids ?? [];
      this.verifiedAddress = getAddress(wallet.address);

      const guards: string[] = [];
      guards.push(this.ownerId
        ? `owner ${this.ownerId} enforced`
        : 'NO OWNER — the app secret alone can move this wallet');
      guards.push(this.policyIds.length
        ? `${this.policyIds.length} policy(ies) attached`
        : 'NO POLICY — nothing caps a transaction at the enclave');

      return {
        ready: true,
        address: this.verifiedAddress,
        detail: `privy wallet ${this.cfg.walletId} verified as ${this.verifiedAddress}; ${guards.join('; ')}`,
      };
    } catch (e) {
      return {
        ready: false,
        address: null,
        detail: `privy unreachable or credentials rejected: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
      };
    }
  }

  /**
   * Sign — never send. We broadcast through our own RPC so the transaction is
   * validated, logged and reconciled by the same path that tracks every other
   * order. Privy's eth_sendTransaction would broadcast for us and hand back
   * only a hash, cutting our reconciler out of the loop.
   */
  async signTransaction(req: SignRequest): Promise<string> {
    const ready = await this.isReady();
    if (!ready.ready) throw new Error(`refusing to sign: ${ready.detail}`);

    // ── wall 2: what this process is willing to put its name to ──
    if (!isAddress(req.to)) throw new Error('refusing to sign: destination is not a valid address');
    if (this.allowed.size > 0 && !this.allowed.has(req.to.toLowerCase())) {
      throw new Error(
        `refusing to sign: ${getAddress(req.to)} is not on the signer's allowlist. ` +
          'Add it to SIGNER_ALLOWED_TARGETS only after verifying it against the venue\'s own documentation.',
      );
    }
    if (req.value > this.cfg.maxNativeValueWei) {
      throw new Error(
        `refusing to sign: native value ${req.value} wei exceeds the signer ceiling ${this.cfg.maxNativeValueWei} wei`,
      );
    }
    if (!req.intentId) throw new Error('refusing to sign: no intent id — every signature must be attributable');

    // NO `caip2` HERE.
    //
    // Privy's documented example carries `caip2` — but that example is for
    // eth_sendTransaction, where Privy broadcasts and therefore needs to be
    // told which network. eth_signTransaction only signs, and rejects the key
    // outright: `Unrecognized key(s) in object: 'caip2'`.
    //
    // This mattered more than a shape error usually does. The first policy
    // test refused all three cases — including one that should have been
    // allowed — and every refusal was this 400, not the policy engine. Taken
    // at face value it would have read as "the cap works". The chain is bound
    // inside the transaction via chain_id, which is what actually signs.
    const body = {
      method: 'eth_signTransaction',
      params: {
        transaction: {
          to: getAddress(req.to),
          value: `0x${req.value.toString(16)}`,
          data: req.data,
          chain_id: req.chainId,
          ...(req.gas !== undefined ? { gas_limit: `0x${req.gas.toString(16)}` } : {}),
        },
      },
    };

    // The intent id doubles as the idempotency key, so a retry after a timeout
    // cannot produce a second signature for the same order.
    const res = await this.call<{ data?: { signed_transaction?: string; signedTransaction?: string } }>(
      'POST', `/wallets/${encodeURIComponent(this.cfg.walletId)}/rpc`, body, req.intentId,
    );
    const signed = res?.data?.signed_transaction ?? res?.data?.signedTransaction;
    if (!signed || !signed.startsWith('0x')) {
      throw new Error('privy returned no signed transaction — refusing to proceed');
    }
    return signed;
  }
}

/** Read the signer's configuration from the environment. Never logs secrets. */
export function privyConfigFromEnv(): PrivyConfig {
  const maxEth = process.env.SIGNER_MAX_NATIVE_ETH ?? '0.05';
  return {
    appId: process.env.PRIVY_APP_ID ?? '',
    appSecret: process.env.PRIVY_APP_SECRET ?? '',
    walletId: process.env.PRIVY_WALLET_ID ?? '',
    expectedAddress: process.env.TRADING_WALLET_ADDRESS ?? '',
    authorizationKey: process.env.PRIVY_AUTHORIZATION_KEY || undefined,
    allowedTargets: (process.env.SIGNER_ALLOWED_TARGETS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    maxNativeValueWei: BigInt(Math.round(Number(maxEth) * 1e18)),
  };
}
