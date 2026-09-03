import { createPublicClient, encodeFunctionData, getAddress, http, type Address, type Hex } from 'viem';
import {
  USDG_ADDRESS, WETH_ADDRESS, prepareWithdrawalPolicy, publicKeyFromAuthorizationKey,
  restoreManagerPolicies, signPrivyOperatorTransaction, type Ctx,
} from '../live/signing/provisionPrivy.js';

// SWEEPING A PRIVY WALLET BACK TO THE OPERATOR.
//
// This is a decommissioning tool, not a trading path. It exists because the
// standing policy correctly refuses to send funds anywhere except through the
// 0x AllowanceHolder, so recovering money requires a deliberate, temporary,
// narrowly-scoped policy and a ceremony that always puts the original back.
//
// Three properties matter more than convenience here:
//
//  1. ERC-20 FIRST, NATIVE LAST. Every token transfer costs gas. Sweeping the
//     ETH first would strand the tokens in a wallet with nothing left to pay
//     with, and recovering from that needs another funding ceremony.
//
//  2. THE POLICY IS ALWAYS RESTORED. The restore lives in `finally`, so a
//     crash, a revert or a network failure mid-sweep cannot leave the wallet
//     wearing a policy that permits withdrawals.
//
//  3. IT REFUSES TO GUESS. Balances and gas are read live; nothing is inferred
//     from our own ledger, because the ledger is exactly what we would be
//     trying to verify.

const CHAIN_ID = 4663;
const ERC20_TRANSFER = [{
  inputs: [
    { internalType: 'address', name: 'to', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' },
  ],
  name: 'transfer',
  outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
  stateMutability: 'nonpayable',
  type: 'function',
}] as const;

const BALANCE_OF = [{
  inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

/** Native transfers are exactly this; ERC-20 needs headroom for cold storage writes. */
const NATIVE_GAS = 21_000n;
const ERC20_GAS = 90_000n;

export interface SweepStep {
  what: string;
  to: string;
  value: bigint;
  data: Hex;
  gas: bigint;
  txHash?: string;
}

export interface SweepReport {
  walletAddress: string;
  destination: string;
  dryRun: boolean;
  balances: { usdg: bigint; weth: bigint; native: bigint };
  steps: SweepStep[];
  policyRestored: boolean;
}

export async function sweepWalletToOperator(opts: {
  ctx: Ctx;
  rpcUrl: string;
  destination: string;
  runId: string;
  dryRun: boolean;
  /** set false only to recover a wallet whose policy was already permissive */
  useTemporaryPolicy?: boolean;
}): Promise<SweepReport> {
  const destination = getAddress(opts.destination);
  const client = createPublicClient({ transport: http(opts.rpcUrl) });

  // Resolve the wallet's own address from Privy rather than trusting a caller
  // to pass the right one alongside the right wallet id.
  const walletAddress = await resolveWalletAddress(opts.ctx);
  const self = getAddress(walletAddress) as Address;

  if (self.toLowerCase() === destination.toLowerCase()) {
    throw new Error('destination is the wallet itself — nothing to sweep');
  }

  const [usdg, weth, native, fees] = await Promise.all([
    client.readContract({ address: getAddress(USDG_ADDRESS), abi: BALANCE_OF, functionName: 'balanceOf', args: [self] }) as Promise<bigint>,
    client.readContract({ address: getAddress(WETH_ADDRESS), abi: BALANCE_OF, functionName: 'balanceOf', args: [self] }) as Promise<bigint>,
    client.getBalance({ address: self }),
    client.estimateFeesPerGas(),
  ]);

  const maxFeePerGas = fees.maxFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;

  // Reserve gas for the token transfers, then sweep whatever native remains.
  // A negative remainder means the wallet cannot even pay to empty itself.
  const tokenTransfers = (usdg > 0n ? 1n : 0n) + (weth > 0n ? 1n : 0n);
  const reserved = tokenTransfers * ERC20_GAS * maxFeePerGas;
  const nativeSweep = native - reserved - NATIVE_GAS * maxFeePerGas;

  const steps: SweepStep[] = [];
  if (usdg > 0n) {
    steps.push({
      what: `USDG ${(Number(usdg) / 1e6).toFixed(6)}`,
      to: getAddress(USDG_ADDRESS), value: 0n, gas: ERC20_GAS,
      data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: 'transfer', args: [destination, usdg] }),
    });
  }
  if (weth > 0n) {
    steps.push({
      what: `WETH ${(Number(weth) / 1e18).toFixed(18)}`,
      to: getAddress(WETH_ADDRESS), value: 0n, gas: ERC20_GAS,
      data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: 'transfer', args: [destination, weth] }),
    });
  }
  if (nativeSweep > 0n) {
    steps.push({
      what: `ETH ${(Number(nativeSweep) / 1e18).toFixed(18)} (balance minus gas)`,
      to: destination, value: nativeSweep, gas: NATIVE_GAS, data: '0x',
    });
  }

  const report: SweepReport = {
    walletAddress: self, destination, dryRun: opts.dryRun,
    balances: { usdg, weth, native }, steps, policyRestored: false,
  };
  if (opts.dryRun || steps.length === 0) return report;

  let previousPolicyIds: string[] | null = null;
  try {
    if (opts.useTemporaryPolicy !== false) {
      const prepared = await prepareWithdrawalPolicy(
        opts.ctx, destination,
        // cap at the exact balances just read — the policy can never authorise
        // more than the wallet actually holds
        { usdgBaseUnits: usdg, wethWei: weth, nativeWei: nativeSweep > 0n ? nativeSweep : 0n },
        opts.runId,
      );
      previousPolicyIds = prepared.previousPolicyIds;
      if (prepared.walletAddress.toLowerCase() !== self.toLowerCase()) {
        throw new Error('Privy wallet address does not match the address we read balances for');
      }
    }

    let nonce = await client.getTransactionCount({ address: self, blockTag: 'pending' });
    for (const step of steps) {
      const raw = await signPrivyOperatorTransaction(opts.ctx, {
        to: step.to, value: step.value, data: step.data, nonce,
        gas: step.gas, maxFeePerGas, maxPriorityFeePerGas,
        idempotencyKey: `${opts.runId}-sweep-${nonce}`,
      });
      const hash = await client.sendRawTransaction({ serializedTransaction: raw as Hex });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      // Stop on the first failure rather than burning gas on the rest; a
      // reverted token transfer means the native sweep would strand nothing
      // but would also hide which step actually broke.
      if (receipt.status !== 'success') {
        throw new Error(`sweep step reverted (${step.what}): ${hash}`);
      }
      step.txHash = hash;
      nonce += 1;
    }
  } finally {
    if (previousPolicyIds) {
      await restoreManagerPolicies(opts.ctx, previousPolicyIds);
      report.policyRestored = true;
    }
  }
  return report;
}

export interface CredentialCheck {
  ok: boolean;
  appSecret: string;
  walletId: string;
  authorizationKey: string;
  walletAddress?: string;
  ownerId?: string;
}

/**
 * Diagnose the credentials BEFORE touching anything.
 *
 * Three different mistakes all surface as a bare 401 from Privy, and telling
 * them apart afterwards costs a round trip each time: a wrong app secret, a
 * wallet id that belongs to another app, and an authorization key that is not
 * the wallet's owner. The last one is the expensive one — it fails only at the
 * policy PATCH, several steps in, long after the balances have printed and the
 * operator has decided this is going to work.
 *
 * So: check the app secret with a plain read, then compare the local key's
 * PUBLIC half against the owner quorum Privy actually has. Comparing public
 * keys means the private key never leaves the process and is never logged.
 */
export async function checkCredentials(ctx: Ctx): Promise<CredentialCheck> {
  const auth = {
    Authorization: `Basic ${Buffer.from(`${ctx.appId}:${ctx.appSecret}`).toString('base64')}`,
    'privy-app-id': ctx.appId,
  };
  const out: CredentialCheck = {
    ok: false, appSecret: 'unknown', walletId: 'unknown', authorizationKey: 'unknown',
  };

  if (!ctx.appId) { out.appSecret = 'PRIVY_APP_ID is not set'; return out; }
  if (!ctx.appSecret) { out.appSecret = 'PRIVY_APP_SECRET(_FILE) is not set'; return out; }

  const res = await fetch(
    `https://api.privy.io/v1/wallets/${encodeURIComponent(ctx.walletId)}`, { headers: auth },
  );
  if (res.status === 401 || res.status === 403) {
    out.appSecret = `REJECTED (${res.status}) — the app id and app secret do not match`;
    out.walletId = 'not checked';
    out.authorizationKey = 'not checked';
    return out;
  }
  if (res.status === 404) {
    out.appSecret = 'accepted';
    out.walletId = 'NOT FOUND — this wallet id does not belong to this app';
    return out;
  }
  const wallet = await res.json().catch(() => null) as
    { address?: string; owner_id?: string | null } | null;
  if (!res.ok || !wallet?.address) {
    out.appSecret = 'accepted';
    out.walletId = `unreadable (${res.status})`;
    return out;
  }
  out.appSecret = 'accepted';
  out.walletId = `ok — ${wallet.address}`;
  out.walletAddress = wallet.address;
  out.ownerId = wallet.owner_id ?? undefined;

  if (!wallet.owner_id) {
    // No owner means the app secret alone can change policy and sign.
    out.authorizationKey = 'not required — this wallet has no owner';
    out.ok = true;
    return out;
  }
  if (!ctx.authorizationKey) {
    out.authorizationKey = `MISSING — wallet owner is ${wallet.owner_id}, so a key is required`;
    return out;
  }

  let localPublic: string;
  try {
    localPublic = publicKeyFromAuthorizationKey(ctx.authorizationKey);
  } catch (e) {
    out.authorizationKey = `UNREADABLE — ${String((e as Error).message).slice(0, 90)}`;
    return out;
  }

  const q = await fetch(
    `https://api.privy.io/v1/key_quorums/${encodeURIComponent(wallet.owner_id)}`, { headers: auth },
  );
  const quorum = await q.json().catch(() => null) as
    { authorization_keys?: { public_key: string }[] } | null;
  const registered = (quorum?.authorization_keys ?? []).map((k) => k.public_key.replace(/\s/g, ''));
  const mine = localPublic.replace(/\s/g, '');
  if (registered.some((k) => k === mine)) {
    out.authorizationKey = `ok — matches owner quorum ${wallet.owner_id}`;
    out.ok = true;
  } else {
    // The distinguishing bytes start after the shared SPKI header, so show
    // that slice rather than a prefix every P-256 key has in common.
    out.authorizationKey =
      `WRONG KEY — this is not the owner of this wallet.\n` +
      `      owner quorum ${wallet.owner_id} expects: ${registered[0]?.slice(36, 60) ?? '(none registered)'}…\n` +
      `      the key you supplied is:                 ${mine.slice(36, 60)}…`;
  }
  return out;
}

async function resolveWalletAddress(ctx: Ctx): Promise<string> {
  const res = await fetch(`https://api.privy.io/v1/wallets/${encodeURIComponent(ctx.walletId)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${ctx.appId}:${ctx.appSecret}`).toString('base64')}`,
      'privy-app-id': ctx.appId,
    },
  });
  const body = await res.json().catch(() => null) as { address?: string } | null;
  if (!res.ok || !body?.address) throw new Error(`could not read wallet ${ctx.walletId}: ${res.status}`);
  return body.address;
}

/** Human-readable plan, printed before anything is signed. */
export function renderSweep(report: SweepReport): string {
  const lines = [
    `SWEEP ${report.dryRun ? '(DRY RUN — nothing signed)' : '(LIVE)'}`,
    `  from        ${report.walletAddress}`,
    `  to          ${report.destination}`,
    `  USDG        ${(Number(report.balances.usdg) / 1e6).toFixed(6)}`,
    `  WETH        ${(Number(report.balances.weth) / 1e18).toFixed(18)}`,
    `  ETH         ${(Number(report.balances.native) / 1e18).toFixed(18)}`,
    report.steps.length ? '  steps:' : '  steps:      NONE — wallet is empty',
  ];
  for (const s of report.steps) {
    lines.push(`    - ${s.what} -> ${s.to}${s.txHash ? `  tx ${s.txHash}` : ''}`);
  }
  if (!report.dryRun) lines.push(`  policy restored: ${report.policyRestored}`);
  return lines.join('\n');
}
