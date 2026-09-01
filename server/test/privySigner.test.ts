import { generateKeyPairSync, createHash, createVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivySigner, canonicalize, privyConfigFromEnv, type PrivyConfig } from '../src/live/signing/privySigner.js';
import { NoSigner, buildSigner } from '../src/live/signing/signer.js';
import { provisionPrivyWallet } from '../src/live/signing/provisionPrivy.js';
import { ZEROX_ALLOWANCE_HOLDER } from '../src/live/instrumentResolver.js';

const WALLET = '0xD5788b6694a05366FaaeEfEff35c7a5913D02Ff9';
const ZEROX = '0x1111111111111111111111111111111111111111';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    pkcs8Base64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey,
  };
}

const cfg = (over: Partial<PrivyConfig> = {}): PrivyConfig => ({
  appId: 'cmth90rt502280cl7ae6rxcdv',
  appSecret: 'test-secret-never-real',
  walletId: 'twomul6h854hxq2zw6fvxafz',
  expectedAddress: WALLET,
  allowedTargets: [ZEROX],
  maxNativeValueWei: 10n ** 16n, // 0.01 ETH
  ...over,
});

const intent = {
  chainId: 4663,
  to: ZEROX,
  data: '0xdeadbeef',
  value: 0n,
  intentId: 'plz_live_20260831_abc123',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Privy policy replacement', () => {
  it('preserves an existing owner and signs the wallet policy update', async () => {
    const { pkcs8Base64 } = keypair();
    const newPolicyId = 'n'.repeat(24);
    const ownerId = 'o'.repeat(24);
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/wallets/wallet-id')) {
        const updated = requests.some((request) => request.init.method === 'PATCH');
        return new Response(JSON.stringify({
          address: WALLET,
          owner_id: ownerId,
          policy_ids: updated ? [newPolicyId] : ['p'.repeat(24)],
        }), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/policies')) {
        return new Response(JSON.stringify({ id: newPolicyId }), { status: 200 });
      }
      if (method === 'PATCH' && url.endsWith('/wallets/wallet-id')) {
        return new Response(JSON.stringify({ owner_id: ownerId }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await provisionPrivyWallet({
      ctx: {
        appId: 'app-id', appSecret: 'app-secret', walletId: 'wallet-id',
        authorizationKey: pkcs8Base64,
      },
      capUsd: 5,
      chainId: 4663,
    });

    expect(result.ok).toBe(true);
    const policyRequest = requests.find((request) => request.init.method === 'POST')!;
    expect(JSON.parse(String(policyRequest.init.body))).toMatchObject({ owner_id: ownerId });
    const patchRequest = requests.find((request) => request.init.method === 'PATCH')!;
    expect(JSON.parse(String(patchRequest.init.body))).toEqual({ policy_ids: [newPolicyId] });
    expect(new Headers(patchRequest.init.headers).get('privy-authorization-signature')).toBeTruthy();
  });
});

describe('JCS canonicalisation', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"z":{"x":2,"y":1}}');
  });

  it('is stable regardless of key insertion order', () => {
    const one = canonicalize({ version: 1, method: 'POST', url: 'u', body: { b: 1, a: 2 } });
    const two = canonicalize({ body: { a: 2, b: 1 }, url: 'u', method: 'POST', version: 1 });
    expect(one).toBe(two);
  });

  it('drops undefined but keeps null', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('refuses a value it cannot canonicalise identically to the enclave', () => {
    // a float or bigint serialised differently yields a signature Privy
    // rejects with an opaque 401 — far better to fail loudly here
    expect(() => canonicalize({ v: 1.5 })).toThrow(/non-integer/);
    expect(() => canonicalize({ v: 1n })).toThrow(/unsupported value type/);
  });

  it('escapes strings the way JSON does', () => {
    expect(canonicalize({ a: 'x"y' })).toBe('{"a":"x\\"y"}');
  });
});

describe('the authorization signature', () => {
  it('is a real P-256 signature over the canonical request', () => {
    const { pkcs8Base64, publicKey } = keypair();
    const signer = new PrivySigner(cfg({ authorizationKey: pkcs8Base64 }));

    const body = { method: 'eth_signTransaction', caip2: 'eip155:4663' };
    // exercise the private signer through its only public surface
    const signature = (signer as unknown as {
      authorizationSignature(m: string, u: string, b: unknown, h?: Record<string, string>): string | null;
    }).authorizationSignature('POST', 'https://api.privy.io/v1/wallets/w/rpc', body);

    expect(signature).toBeTruthy();

    const expectedPayload = canonicalize({
      version: 1,
      method: 'POST',
      url: 'https://api.privy.io/v1/wallets/w/rpc',
      body,
      headers: { 'privy-app-id': 'cmth90rt502280cl7ae6rxcdv' },
    });
    const verify = createVerify('sha256');
    verify.update(Buffer.from(expectedPayload, 'utf8'));
    verify.end();
    expect(verify.verify(publicKey, Buffer.from(signature!, 'base64'))).toBe(true);
  });

  it('covers the body, so an altered destination invalidates it', () => {
    const { pkcs8Base64, publicKey } = keypair();
    const signer = new PrivySigner(cfg({ authorizationKey: pkcs8Base64 }));
    const sign = (b: unknown) => (signer as any).authorizationSignature('POST', 'https://x/rpc', b);

    const original = { to: ZEROX, value: '0x0' };
    const tampered = { to: '0x2222222222222222222222222222222222222222', value: '0x0' };
    const signature = sign(original);

    const verify = createVerify('sha256');
    verify.update(Buffer.from(canonicalize({
      version: 1, method: 'POST', url: 'https://x/rpc', body: tampered,
      headers: { 'privy-app-id': 'cmth90rt502280cl7ae6rxcdv' },
    }), 'utf8'));
    verify.end();
    expect(verify.verify(publicKey, Buffer.from(signature, 'base64'))).toBe(false);
  });

  it('is omitted when no authorization key is configured', () => {
    const signer = new PrivySigner(cfg());
    expect((signer as any).authorizationSignature('POST', 'https://x/rpc', {})).toBeNull();
  });
});

describe('refusals that do not need the network', () => {
  it('reports every missing credential by name', async () => {
    const r = await new PrivySigner(cfg({ appSecret: '', walletId: '' })).isReady();
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(/PRIVY_APP_SECRET/);
    expect(r.detail).toMatch(/PRIVY_WALLET_ID/);
  });

  it('rejects a malformed expected address before contacting anything', async () => {
    const r = await new PrivySigner(cfg({ expectedAddress: 'not-an-address' })).isReady();
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(/not a valid EVM address/);
  });

  it('will not sign while it is not ready', async () => {
    const signer = new PrivySigner(cfg({ appSecret: '' }));
    await expect(signer.signTransaction(intent)).rejects.toThrow(/refusing to sign/);
  });

  it('treats an extra signer policy as a readiness failure', async () => {
    const { pkcs8Base64 } = keypair();
    const allowed = [ZEROX_ALLOWANCE_HOLDER.toLowerCase()];
    const allowedHash = createHash('sha256').update(JSON.stringify(allowed)).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'wallet-id', address: WALLET, owner_id: 'owner-id',
      additional_signers: [{ signer_id: 'runtime-id', override_policy_ids: ['expected-id', 'unexpected-id'] }],
    }), { status: 200 })));
    const signer = new PrivySigner(cfg({ authorizationKey: pkcs8Base64,
      expectedSignerId: 'runtime-id', expectedPolicyIds: ['expected-id'], allowedTargets: allowed,
      expectedAllowedTargetsHash: allowedHash, maxNativeValueWei: 0n }));
    const readiness = await signer.isReady();
    expect(readiness.ready).toBe(false);
    expect(readiness.detail).toMatch(/EXTRA/);
  });
});

describe('the signer refuses on its own account', () => {
  /** ready without a network call, so the guards below are what is under test */
  function readySigner(over: Partial<PrivyConfig> = {}) {
    const signer = new PrivySigner(cfg(over));
    (signer as any).isReady = async () => ({ ready: true, address: WALLET, detail: 'stubbed ready' });
    return signer;
  }

  it('refuses a destination that is not on the allowlist', async () => {
    const signer = readySigner();
    await expect(
      signer.signTransaction({ ...intent, to: '0x3333333333333333333333333333333333333333' }),
    ).rejects.toThrow(/not on the signer's allowlist/);
  });

  it('refuses a native value over the ceiling', async () => {
    const signer = readySigner({ maxNativeValueWei: 1000n });
    await expect(signer.signTransaction({ ...intent, value: 1001n }))
      .rejects.toThrow(/native value .* forbidden/);
  });

  it('allows zero native value and reaches the signing service', async () => {
    const signer = readySigner({ maxNativeValueWei: 0n });
    await expect(signer.signTransaction({ ...intent, value: 0n }))
      .rejects.toThrow(/privy POST|fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/);
  });

  it('refuses the wrong chain before contacting Privy', async () => {
    const signer = readySigner({ maxNativeValueWei: 0n });
    await expect(signer.signTransaction({ ...intent, chainId: 1 }))
      .rejects.toThrow(/not Robinhood mainnet 4663/);
  });

  it('refuses a signature with no intent id — every one must be attributable', async () => {
    const signer = readySigner();
    await expect(signer.signTransaction({ ...intent, intentId: '' }))
      .rejects.toThrow(/no intent id/);
  });

  it('refuses a malformed destination', async () => {
    const signer = readySigner();
    await expect(signer.signTransaction({ ...intent, to: '0xnope' }))
      .rejects.toThrow(/not a valid address/);
  });
});

describe('buildSigner', () => {
  it('defaults to the signer that cannot move anything', () => {
    const previous = process.env.SIGNER_PROVIDER;
    delete process.env.SIGNER_PROVIDER;
    expect(buildSigner()).toBeInstanceOf(NoSigner);
    process.env.SIGNER_PROVIDER = previous;
  });

  it('constructs the privy signer without throwing on missing credentials', () => {
    const previous = process.env.SIGNER_PROVIDER;
    process.env.SIGNER_PROVIDER = 'privy';
    // a missing credential must surface as a preflight blocker, not a crash on boot
    expect(() => buildSigner()).not.toThrow();
    process.env.SIGNER_PROVIDER = previous;
  });

  it('still refuses an unknown provider outright', () => {
    const previous = process.env.SIGNER_PROVIDER;
    process.env.SIGNER_PROVIDER = 'turnkey';
    expect(() => buildSigner()).toThrow(/not implemented in this build/);
    process.env.SIGNER_PROVIDER = previous;
  });

  it('forbids putting the Privy authorization private key directly in production env', () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorInline = process.env.PRIVY_AUTHORIZATION_KEY;
    const priorFile = process.env.PRIVY_AUTHORIZATION_KEY_FILE;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PRIVY_AUTHORIZATION_KEY = 'inline-private-key';
      delete process.env.PRIVY_AUTHORIZATION_KEY_FILE;
      expect(() => privyConfigFromEnv()).toThrow(/forbidden in production/);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorInline === undefined) delete process.env.PRIVY_AUTHORIZATION_KEY; else process.env.PRIVY_AUTHORIZATION_KEY = priorInline;
      if (priorFile === undefined) delete process.env.PRIVY_AUTHORIZATION_KEY_FILE; else process.env.PRIVY_AUTHORIZATION_KEY_FILE = priorFile;
    }
  });

  it('forbids putting the Privy app secret directly in production env', () => {
    const prior = {
      nodeEnv: process.env.NODE_ENV,
      appSecret: process.env.PRIVY_APP_SECRET,
      appSecretFile: process.env.PRIVY_APP_SECRET_FILE,
      authKey: process.env.PRIVY_AUTHORIZATION_KEY,
    };
    try {
      process.env.NODE_ENV = 'production';
      process.env.PRIVY_APP_SECRET = 'inline-app-secret';
      delete process.env.PRIVY_APP_SECRET_FILE;
      delete process.env.PRIVY_AUTHORIZATION_KEY;
      expect(() => privyConfigFromEnv()).toThrow(/PRIVY_APP_SECRET is forbidden/);
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      };
      restore('NODE_ENV', prior.nodeEnv);
      restore('PRIVY_APP_SECRET', prior.appSecret);
      restore('PRIVY_APP_SECRET_FILE', prior.appSecretFile);
      restore('PRIVY_AUTHORIZATION_KEY', prior.authKey);
    }
  });
});

describe('the transaction Privy is asked to sign is COMPLETE', () => {
  /** capture the body without a network call */
  function capturing(over: Partial<PrivyConfig> = {}) {
    const signer = new PrivySigner(cfg(over));
    const sent: any[] = [];
    (signer as any).isReady = async () => ({ ready: true, address: WALLET, detail: 'stubbed' });
    (signer as any).call = async (_m: string, _p: string, body: any) => {
      sent.push(body);
      return { data: { signed_transaction: '0x02f8aa' } };
    };
    return { signer, sent };
  }

  it('carries nonce and BOTH fee fields', async () => {
    const { signer, sent } = capturing();
    await signer.signTransaction({
      chainId: 4663, to: ZEROX, data: '0xdeadbeef', value: 0n, gas: 250000n,
      nonce: 7, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n,
      intentId: 'i1',
    });
    const tx = sent[0].params.transaction;
    // Privy defaults anything omitted to ZERO, and a transaction offering zero
    // gas price is valid, signable, and never mined — an order stuck pending
    // forever while the ledger believes it was submitted.
    expect(tx.nonce).toBe(7);
    expect(tx.max_fee_per_gas).toBe('0x77359400');
    expect(tx.max_priority_fee_per_gas).toBe('0xf4240');
    expect(tx.chain_id).toBe(4663);
    expect(tx.gas_limit).toBe('0x3d090');
  });

  it('does NOT send caip2 — eth_signTransaction rejects it outright', async () => {
    const { signer, sent } = capturing();
    await signer.signTransaction({
      chainId: 4663, to: ZEROX, data: '0xdeadbeef', value: 0n, nonce: 0,
      maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, intentId: 'i2',
    });
    expect(sent[0]).not.toHaveProperty('caip2');
    expect(sent[0].method).toBe('eth_signTransaction');
  });

  it('omits fee fields entirely when the caller supplies none, rather than sending zeros', async () => {
    const { signer, sent } = capturing();
    await signer.signTransaction({
      chainId: 4663, to: ZEROX, data: '0xdeadbeef', value: 0n, intentId: 'i3',
    });
    const tx = sent[0].params.transaction;
    // an absent field is a caller bug we can find; an explicit zero is one we cannot
    expect(tx).not.toHaveProperty('max_fee_per_gas');
    expect(tx).not.toHaveProperty('nonce');
  });
});
