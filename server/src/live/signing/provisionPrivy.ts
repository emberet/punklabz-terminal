import { createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { canonicalize, normalizeAuthorizationKey } from './privySigner.js';

// PROVISIONING WALL #2.
//
// Attaches the authorization key as the wallet's owner and installs the
// spending policy. Both live at Privy, in the enclave, where a bug in this
// codebase cannot reach them — which is the entire point of having them.
//
// ORDERING MATTERS. Once `owner_id` is set, every subsequent PATCH to the
// wallet requires an authorization signature. So the policy is created first
// and attached in the SAME PATCH that sets the owner: one unsigned mutation,
// no chicken-and-egg, no window where the wallet has an owner but no policy.
//
// This is a script rather than a dashboard click because a policy typed by
// hand into a form is a policy nobody can review, re-apply, or diff.

const PRIVY_API = 'https://api.privy.io/v1';

/** USDG has SIX decimals. $25 = 25_000_000 = 0x17D7840. */
export const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const WETH_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';

export function usdgCapHex(dollars: number): string {
  return `0x${BigInt(Math.round(dollars * 1e6)).toString(16).toUpperCase()}`;
}

/**
 * The policy.
 *
 * Note `eth_signTransaction`, NOT `eth_sendTransaction`. Every example in
 * Privy's documentation uses the latter; our signer calls the former, so a
 * rule copied verbatim from the docs would match nothing at all and enforce
 * nothing while appearing configured.
 *
 * The policy bounds both layers: exact ERC-20 approval spender/amount and the
 * AllowanceHolder exec token/amount. The application independently decodes the
 * nested Settler call, recipient, output token, and minimum received.
 */
/**
 * A calldata condition must carry the ABI of the function it decodes — the
 * policy engine has no token registry to look it up in, and rightly refuses to
 * guess what four bytes of a selector mean.
 */
const ERC20_APPROVE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const ALLOWANCE_HOLDER_EXEC_ABI = [{
  inputs: [
    { internalType: 'address', name: 'operator', type: 'address' },
    { internalType: 'address', name: 'token', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' },
    { internalType: 'address payable', name: 'target', type: 'address' },
    { internalType: 'bytes', name: 'data', type: 'bytes' },
  ],
  name: 'exec',
  outputs: [{ internalType: 'bytes', name: 'result', type: 'bytes' }],
  stateMutability: 'payable',
  type: 'function',
}];

export function buildPolicy(capUsd: number, chainId: number) {
  const cap = usdgCapHex(capUsd);
  // Hard signer ceiling for exits. This assumes no WETH is acquired below a
  // $1,000 reference floor; the application applies the tighter live quote
  // limit. If that floor is no longer conservative, halt and replace policy.
  const wethCap = `0x${(BigInt(Math.round(capUsd)) * 1_000_000_000_000_000n).toString(16).toUpperCase()}`;
  // Privy caps both policy and rule names at 50 characters.
  return {
    version: '1.0',
    name: `PunkLabz operator $${capUsd} cap`,
    chain_type: 'ethereum',
    rules: [
      {
        name: `USDG approval <= $${capUsd}`,
        method: 'eth_signTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(chainId) },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: USDG_ADDRESS },
          {
            field_source: 'ethereum_calldata',
            field: 'approve.spender',
            abi: ERC20_APPROVE_ABI,
            operator: 'eq',
            value: ZEROX_ALLOWANCE_HOLDER,
          },
          {
            field_source: 'ethereum_calldata',
            field: 'approve.amount',
            abi: ERC20_APPROVE_ABI,
            operator: 'lte',
            value: cap,
          },
        ],
      },
      {
        name: 'WETH approval for exits',
        method: 'eth_signTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(chainId) },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: WETH_ADDRESS },
          {
            field_source: 'ethereum_calldata', field: 'approve.spender', abi: ERC20_APPROVE_ABI,
            operator: 'eq', value: ZEROX_ALLOWANCE_HOLDER,
          },
          {
            field_source: 'ethereum_calldata', field: 'approve.amount', abi: ERC20_APPROVE_ABI,
            operator: 'lte', value: wethCap,
          },
        ],
      },
      {
        name: 'USDG swaps via 0x',
        method: 'eth_signTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(chainId) },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: ZEROX_ALLOWANCE_HOLDER },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0x0' },
          {
            field_source: 'ethereum_calldata', field: 'exec.token', abi: ALLOWANCE_HOLDER_EXEC_ABI,
            operator: 'eq', value: USDG_ADDRESS,
          },
          {
            field_source: 'ethereum_calldata', field: 'exec.amount', abi: ALLOWANCE_HOLDER_EXEC_ABI,
            operator: 'lte', value: cap,
          },
        ],
      },
      {
        name: 'WETH exits via 0x',
        method: 'eth_signTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(chainId) },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: ZEROX_ALLOWANCE_HOLDER },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0x0' },
          {
            field_source: 'ethereum_calldata', field: 'exec.token', abi: ALLOWANCE_HOLDER_EXEC_ABI,
            operator: 'eq', value: WETH_ADDRESS,
          },
          {
            field_source: 'ethereum_calldata', field: 'exec.amount', abi: ALLOWANCE_HOLDER_EXEC_ABI,
            operator: 'lte', value: wethCap,
          },
        ],
      },
    ],
  };
}

/** base64 SPKI DER, which is the only form Privy accepts for registration. */
export function publicKeyFromAuthorizationKey(privateKeyBase64: string): string {
  const priv = createPrivateKey({
    key: normalizeAuthorizationKey(privateKeyBase64),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
}

interface Ctx {
  appId: string;
  appSecret: string;
  walletId: string;
  authorizationKey?: string;
}

function authorizationSignature(ctx: Ctx, method: string, url: string, body: unknown): string | null {
  if (!ctx.authorizationKey) return null;
  const payload = {
    version: 1,
    method,
    url,
    body,
    headers: { 'privy-app-id': ctx.appId },
  };
  const key = createPrivateKey({
    key: normalizeAuthorizationKey(ctx.authorizationKey), format: 'der', type: 'pkcs8',
  });
  const signer = createSign('sha256');
  signer.update(Buffer.from(canonicalize(payload), 'utf8'));
  signer.end();
  return signer.sign(key).toString('base64');
}

async function call(ctx: Ctx, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, sign = false) {
  const url = `${PRIVY_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${ctx.appId}:${ctx.appSecret}`).toString('base64')}`,
    'privy-app-id': ctx.appId,
    'Content-Type': 'application/json',
  };
  if (sign) {
    const sig = authorizationSignature(ctx, method, url, body ?? {});
    if (sig) headers['privy-authorization-signature'] = sig;
  }
  const res = await fetch(url, {
    method, headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

export interface ProvisionResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  policyId: string | null;
  ownerId: string | null;
}

export async function provisionPrivyWallet(opts: {
  ctx: Ctx;
  capUsd: number;
  chainId: number;
  dryRun?: boolean;
}): Promise<ProvisionResult> {
  const { ctx, capUsd, chainId } = opts;
  const steps: ProvisionResult['steps'] = [];
  const note = (step: string, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail });
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${step.padEnd(28)} ${detail}`);
  };

  if (!ctx.authorizationKey) {
    note('authorization key', false, 'Privy authorization key not loaded — nothing to attach as owner');
    return { ok: false, steps, policyId: null, ownerId: null };
  }

  // ── 0. what is the wallet's state right now? ──
  const before = await call(ctx, 'GET', `/wallets/${ctx.walletId}`);
  if (!before.ok) {
    note('read wallet', false, `${before.status}: ${JSON.stringify(before.body).slice(0, 160)}`);
    return { ok: false, steps, policyId: null, ownerId: null };
  }
  note('read wallet', true,
    `${before.body.address} | owner ${before.body.owner_id ?? 'NONE'} | policies ${(before.body.policy_ids ?? []).length}`);

  let publicKey: string;
  try {
    publicKey = publicKeyFromAuthorizationKey(ctx.authorizationKey);
    note('derive public key', true, `${publicKey.slice(0, 24)}… (base64 SPKI DER)`);
  } catch (e) {
    note('derive public key', false, String(e instanceof Error ? e.message : e));
    return { ok: false, steps, policyId: null, ownerId: null };
  }

  const policy = buildPolicy(capUsd, chainId);
  if (opts.dryRun) {
    note('DRY RUN', true, 'nothing was changed');
    console.log(JSON.stringify(policy, null, 2));
    return { ok: true, steps, policyId: null, ownerId: null };
  }

  // ── 1. policy first: it needs no authorization signature yet ──
  const created = await call(ctx, 'POST', '/policies', policy);
  if (!created.ok) {
    note('create policy', false, `${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
    return { ok: false, steps, policyId: null, ownerId: null };
  }
  const policyId: string = created.body.id;
  note('create policy', true, `${policyId} — ${policy.rules.length} rules, cap ${usdgCapHex(capUsd)}`);

  // ── 2. owner AND policy in ONE patch ──
  // Setting the owner makes every later PATCH require a signature, so doing
  // both at once avoids a window where the wallet has an owner but no cap.
  const patched = await call(ctx, 'PATCH', `/wallets/${ctx.walletId}`, {
    owner: { public_key: publicKey },
    policy_ids: [policyId],
  });
  if (!patched.ok) {
    note('attach owner + policy', false, `${patched.status}: ${JSON.stringify(patched.body).slice(0, 300)}`);
    return { ok: false, steps, policyId, ownerId: null };
  }
  note('attach owner + policy', true, `owner_id ${patched.body.owner_id ?? '(not reported)'}`);

  // ── 3. read back: the only evidence that counts ──
  const after = await call(ctx, 'GET', `/wallets/${ctx.walletId}`);
  const ownerId = after.body?.owner_id ?? null;
  const policies: string[] = after.body?.policy_ids ?? [];
  const ok = !!ownerId && policies.includes(policyId);
  note('verify', ok,
    ok ? `owner ${ownerId}, policy ${policies.join(',')}`
       : `owner ${ownerId ?? 'NONE'}, policies ${JSON.stringify(policies)} — NOT as intended`);

  return { ok, steps, policyId, ownerId };
}
