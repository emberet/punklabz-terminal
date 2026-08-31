import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrivySigner, canonicalize, type PrivyConfig } from '../src/live/signing/privySigner.js';
import { NoSigner, buildSigner } from '../src/live/signing/signer.js';

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
      .rejects.toThrow(/exceeds the signer ceiling/);
  });

  it('allows a value exactly at the ceiling', async () => {
    const signer = readySigner({ maxNativeValueWei: 1000n });
    // gets past the guards and fails at the network, which is the next step
    await expect(signer.signTransaction({ ...intent, value: 1000n }))
      .rejects.toThrow(/privy POST|fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/);
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
});
