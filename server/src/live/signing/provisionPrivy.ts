import { createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { getAddress, parseEther } from 'viem';
import { canonicalize, normalizeAuthorizationKey } from './privySigner.js';

// PROVISIONING WALL #2.
//
// Attaches the authorization key as the wallet's owner and installs the
// spending policy. Both live at Privy, in the enclave, where a bug in this
// codebase cannot reach them — which is the entire point of having them.
//
// ORDERING MATTERS. A fresh wallet gets owner and policy in one PATCH. An
// existing owned wallet keeps that owner and signs the policy-only PATCH with
// the current authorization key. Neither path creates an unguarded interval
// or rotates custody as a side effect of changing policy.
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

export interface Ctx {
  appId: string;
  appSecret: string;
  walletId: string;
  authorizationKey?: string;
}

function authorizationSignature(
  ctx: Ctx,
  method: string,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): string | null {
  if (!ctx.authorizationKey) return null;
  const payload = {
    version: 1,
    method,
    url,
    body,
    headers: { 'privy-app-id': ctx.appId, ...extraHeaders },
  };
  const key = createPrivateKey({
    key: normalizeAuthorizationKey(ctx.authorizationKey), format: 'der', type: 'pkcs8',
  });
  const signer = createSign('sha256');
  signer.update(Buffer.from(canonicalize(payload), 'utf8'));
  signer.end();
  return signer.sign(key).toString('base64');
}

async function call(
  ctx: Ctx,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  sign = false,
  idempotencyKey?: string,
) {
  const url = `${PRIVY_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${ctx.appId}:${ctx.appSecret}`).toString('base64')}`,
    'privy-app-id': ctx.appId,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['privy-idempotency-key'] = idempotencyKey;
  if (sign) {
    const sig = authorizationSignature(
      ctx, method, url, body ?? {},
      idempotencyKey ? { 'privy-idempotency-key': idempotencyKey } : {},
    );
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

const ERC20_TRANSFER_ABI = [{
  inputs: [
    { internalType: 'address', name: 'to', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' },
  ],
  name: 'transfer',
  outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
  stateMutability: 'nonpayable',
  type: 'function',
}];

export function buildManagerFundingPolicy(traderAddress: string) {
  return {
    version: '1.0',
    name: 'PunkLabz exact Trader seed',
    chain_type: 'ethereum',
    rules: [
      {
        name: 'Exactly 5 USDG to Trader', method: 'eth_signTransaction', action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: USDG_ADDRESS },
          { field_source: 'ethereum_calldata', field: 'transfer.to', abi: ERC20_TRANSFER_ABI, operator: 'eq', value: traderAddress },
          { field_source: 'ethereum_calldata', field: 'transfer.amount', abi: ERC20_TRANSFER_ABI, operator: 'eq', value: usdgCapHex(5) },
        ],
      },
      {
        name: 'Exactly 0.005 ETH to Trader', method: 'eth_signTransaction', action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: traderAddress },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0x11C37937E08000' },
        ],
      },
    ],
  };
}

/** A temporary policy for one exact native-ETH gas-reserve transfer. */
export function buildManagerGasTopUpPolicy(traderAddress: string, amountEth: string) {
  const recipient = getAddress(traderAddress);
  const amountWei = parseEther(amountEth);
  if (amountWei <= 0n || amountWei > parseEther('0.01')) {
    throw new Error('Manager gas top-up must be greater than 0 and no more than 0.01 ETH');
  }
  return {
    version: '1.0',
    name: 'PunkLabz exact Trader gas top-up',
    chain_type: 'ethereum',
    rules: [{
      name: `Exactly ${amountEth} ETH to Trader`,
      method: 'eth_signTransaction',
      action: 'ALLOW',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: recipient },
        { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: `0x${amountWei.toString(16).toUpperCase()}` },
      ],
    }],
  };
}

async function attachTemporaryManagerPolicy(
  ctx: Ctx,
  policy: ReturnType<typeof buildManagerFundingPolicy> | ReturnType<typeof buildManagerGasTopUpPolicy>,
  idempotencyKey: string,
  beforeAttach?: (previousPolicyIds: string[]) => void | Promise<void>,
): Promise<{ policyId: string; previousPolicyIds: string[]; ownerId: string; walletAddress: string }> {
  const before = await call(ctx, 'GET', `/wallets/${ctx.walletId}`);
  if (!before.ok || !before.body?.owner_id || !before.body?.address) {
    throw new Error('Manager wallet owner/address could not be verified');
  }
  const previousPolicyIds = [...(before.body.policy_ids ?? [])];
  await beforeAttach?.(previousPolicyIds);
  const created = await call(ctx, 'POST', '/policies', {
    ...policy, owner_id: before.body.owner_id,
  }, false, idempotencyKey);
  if (!created.ok || !created.body?.id) {
    throw new Error(`Manager temporary policy creation failed: ${created.status}`);
  }
  const policyId = created.body.id as string;
  const patched = await call(ctx, 'PATCH', `/wallets/${ctx.walletId}`, { policy_ids: [policyId] }, true);
  if (!patched.ok) throw new Error(`Manager temporary policy attach failed: ${patched.status}`);
  const verified = await call(ctx, 'GET', `/wallets/${ctx.walletId}`);
  if (!verified.ok || !(verified.body?.policy_ids ?? []).includes(policyId)) {
    throw new Error('Manager temporary policy read-back failed');
  }
  return {
    policyId, previousPolicyIds, ownerId: before.body.owner_id, walletAddress: before.body.address,
  };
}

export async function prepareManagerFundingPolicy(
  ctx: Ctx,
  traderAddress: string,
  runId: string,
): Promise<{ policyId: string; previousPolicyIds: string[]; ownerId: string; walletAddress: string }> {
  return attachTemporaryManagerPolicy(
    ctx,
    buildManagerFundingPolicy(traderAddress),
    `${runId}-manager-funding-policy`,
  );
}

export async function prepareManagerGasTopUpPolicy(
  ctx: Ctx,
  traderAddress: string,
  amountEth: string,
  runId: string,
  beforeAttach?: (previousPolicyIds: string[]) => void | Promise<void>,
): Promise<{ policyId: string; previousPolicyIds: string[]; ownerId: string; walletAddress: string }> {
  return attachTemporaryManagerPolicy(
    ctx,
    buildManagerGasTopUpPolicy(traderAddress, amountEth),
    `${runId}-manager-gas-top-up-policy`,
    beforeAttach,
  );
}

export async function restoreManagerPolicies(ctx: Ctx, policyIds: string[]): Promise<void> {
  const patched = await call(ctx, 'PATCH', `/wallets/${ctx.walletId}`, { policy_ids: policyIds }, true);
  if (!patched.ok) throw new Error(`Manager policy restore failed: ${patched.status}`);
  const verified = await call(ctx, 'GET', `/wallets/${ctx.walletId}`);
  const actual = [...(verified.body?.policy_ids ?? [])].sort();
  const expected = [...policyIds].sort();
  if (!verified.ok || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Manager policy restore read-back failed');
  }
}

export async function signPrivyOperatorTransaction(ctx: Ctx, opts: {
  to: string;
  value: bigint;
  data: string;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  idempotencyKey: string;
}): Promise<string> {
  const body = {
    method: 'eth_signTransaction',
    params: { transaction: {
      to: opts.to,
      value: `0x${opts.value.toString(16)}`,
      data: opts.data,
      chain_id: 4663,
      nonce: opts.nonce,
      gas_limit: `0x${opts.gas.toString(16)}`,
      max_fee_per_gas: `0x${opts.maxFeePerGas.toString(16)}`,
      max_priority_fee_per_gas: `0x${opts.maxPriorityFeePerGas.toString(16)}`,
    } },
  };
  const signed = await call(
    ctx, 'POST', `/wallets/${ctx.walletId}/rpc`, body, true, opts.idempotencyKey,
  );
  const raw = signed.body?.data?.signed_transaction ?? signed.body?.data?.signedTransaction;
  if (!signed.ok || typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new Error(`Privy Manager signing failed: ${signed.status}`);
  }
  return raw;
}

export interface IsolatedTraderProvisionResult {
  walletId: string;
  walletAddress: string;
  managementQuorumId: string;
  runtimeSignerId: string;
  policyId: string;
}

/** Create the isolated Trader in one reviewable, idempotent Privy ceremony. */
export async function provisionIsolatedTrader(opts: {
  appId: string;
  appSecret: string;
  managementPublicKey: string;
  runtimePublicKey: string;
  runId: string;
}): Promise<IsolatedTraderProvisionResult> {
  const ctx: Ctx = { appId: opts.appId, appSecret: opts.appSecret, walletId: '' };
  const create = async (path: string, body: unknown, key: string) => {
    const result = await call(ctx, 'POST', path, body, false, `${opts.runId}-${key}`);
    if (!result.ok) throw new Error(`Privy ${path} ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
    return result.body as any;
  };
  const management = await create('/key_quorums', {
    display_name: 'PunkLabz Trader management',
    public_keys: [opts.managementPublicKey],
    authorization_threshold: 1,
  }, 'management-quorum');
  const runtime = await create('/key_quorums', {
    display_name: 'PunkLabz Trader runtime',
    public_keys: [opts.runtimePublicKey],
    authorization_threshold: 1,
  }, 'runtime-quorum');
  if (!management.id || !runtime.id) throw new Error('Privy did not return both quorum ids');

  const policy = await create('/policies', {
    ...buildPolicy(5, 4663),
    owner_id: management.id,
  }, 'runtime-policy');
  if (!policy.id) throw new Error('Privy did not return the runtime policy id');

  const wallet = await create('/wallets', {
    chain_type: 'ethereum',
    display_name: 'PunkLabz Robinhood Trader 01',
    external_id: `punklabz_trader_${opts.runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`,
    owner_id: management.id,
    policy_ids: [],
    additional_signers: [{ signer_id: runtime.id, override_policy_ids: [policy.id] }],
  }, 'trader-wallet');
  if (!wallet.id || !wallet.address) throw new Error('Privy did not return the Trader wallet identity');

  ctx.walletId = wallet.id;
  const verified = await call(ctx, 'GET', `/wallets/${wallet.id}`);
  const signer = (verified.body?.additional_signers ?? []).find((entry: any) => entry.signer_id === runtime.id);
  if (!verified.ok || verified.body?.owner_id !== management.id
    || !signer?.override_policy_ids?.includes(policy.id)) {
    throw new Error('Privy read-back did not prove the intended owner, runtime signer, and override policy');
  }
  return {
    walletId: wallet.id,
    walletAddress: wallet.address,
    managementQuorumId: management.id,
    runtimeSignerId: runtime.id,
    policyId: policy.id,
  };
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
  // Give a replacement policy the same owner as an already-guarded wallet.
  // Otherwise a later policy mutation would remain app-secret controlled.
  const policyBody = before.body.owner_id
    ? { ...policy, owner_id: before.body.owner_id }
    : policy;
  const created = await call(ctx, 'POST', '/policies', policyBody);
  if (!created.ok) {
    note('create policy', false, `${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
    return { ok: false, steps, policyId: null, ownerId: null };
  }
  const policyId: string = created.body.id;
  note('create policy', true, `${policyId} — ${policy.rules.length} rules, cap ${usdgCapHex(capUsd)}`);

  // ── 2. attach the policy, preserving any existing owner ──
  // A previously-owned wallet requires a signed PATCH. Re-sending `owner`
  // would rotate custody while trying to tighten policy, which is too much
  // authority for this operation. A fresh wallet still sets both together.
  const patchBody = before.body.owner_id
    ? { policy_ids: [policyId] }
    : { owner: { public_key: publicKey }, policy_ids: [policyId] };
  const patched = await call(
    ctx, 'PATCH', `/wallets/${ctx.walletId}`, patchBody, !!before.body.owner_id,
  );
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
