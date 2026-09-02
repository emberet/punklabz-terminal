import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { ROBINHOOD_MAINNET_CHAIN_ID, USDG } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { rhClient } from '../chain/rhChain.js';
import { appendAudit } from '../audit/auditLog.js';
import { latestSubscription, upsertSubscription } from './subscriptions.js';

export const USDG_MEMBERSHIP_RAW = 20_000_000n;
export const MEMBERSHIP_PERIOD_MS = 30 * 86_400_000;
export const MEMBERSHIP_GRACE_MS = 48 * 60 * 60_000;
export const PAYMENT_INTENT_TTL_MS = 30 * 60_000;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface UsdgPaymentIntentView {
  id: string;
  chainId: number;
  tokenAddress: string;
  payerAddress: string;
  recipientAddress: string;
  rawAmount: string;
  status: string;
  txHash: string | null;
  expiresAt: number;
  error: string | null;
}

function intentView(row: any): UsdgPaymentIntentView {
  return {
    id: row.public_id, chainId: row.chain_id, tokenAddress: row.token_address,
    payerAddress: row.payer_address, recipientAddress: row.recipient_address,
    rawAmount: row.raw_amount, status: row.status, txHash: row.tx_hash ?? null,
    expiresAt: row.expires_at, error: row.error ?? null,
  };
}

export function linkedWalletAddresses(db: DB, userId: number): string[] {
  return (db.prepare(
    `SELECT address FROM user_wallet_links
     WHERE user_id=? AND chain_id=4663 AND revoked_at IS NULL ORDER BY verified_at`,
  ).all(userId) as { address: string }[]).map((row) => row.address.toLowerCase());
}

export function recordWalletLink(db: DB, userId: number, address: string, provider = 'wallet_signature'): void {
  const normalized = getAddress(address).toLowerCase();
  const existing = db.prepare(
    `SELECT user_id,revoked_at FROM user_wallet_links WHERE chain_id=4663 AND address=?`,
  ).get(normalized) as { user_id: number; revoked_at: number | null } | undefined;
  if (existing && existing.user_id !== userId && existing.revoked_at === null) {
    throw new Error('that wallet is already linked to another PunkLabz account');
  }
  if (existing) {
    db.prepare(
      `UPDATE user_wallet_links
       SET user_id=?,kind='external',provider=?,provider_user_id=NULL,verified_at=?,revoked_at=NULL
       WHERE chain_id=4663 AND address=?`,
    ).run(userId, provider, Date.now(), normalized);
  } else {
    db.prepare(
      `INSERT INTO user_wallet_links
        (user_id, chain_id, address, kind, provider, verified_at, revoked_at)
       VALUES (?, 4663, ?, 'external', ?, ?, NULL)`,
    ).run(userId, normalized, provider, Date.now());
  }
}

export function createUsdgPaymentIntent(db: DB, userId: number, payerAddress: string): UsdgPaymentIntentView {
  if (config.billingProvider !== 'usdg' || !config.billingTreasuryAddress) {
    throw new Error('USDG membership is not configured');
  }
  const payer = getAddress(payerAddress).toLowerCase();
  if (!linkedWalletAddresses(db, userId).includes(payer)) {
    throw new Error('membership payer must be a wallet linked to this account');
  }
  const now = Date.now();
  db.prepare(
    `UPDATE usdg_payment_intents SET status='expired', updated_at=?
     WHERE user_id=? AND status IN ('pending','confirming') AND expires_at<=?`,
  ).run(now, userId, now);
  const existing = db.prepare(
    `SELECT * FROM usdg_payment_intents
     WHERE user_id=? AND payer_address=? AND status IN ('pending','confirming') AND expires_at>?
     ORDER BY id DESC LIMIT 1`,
  ).get(userId, payer, now);
  if (existing) return intentView(existing);
  const publicId = randomUUID();
  db.prepare(
    `INSERT INTO usdg_payment_intents
      (public_id,user_id,chain_id,token_address,payer_address,recipient_address,
       raw_amount,status,expires_at,created_at,updated_at)
     VALUES (?, ?, 4663, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(publicId, userId, USDG.address.toLowerCase(), payer,
    config.billingTreasuryAddress, USDG_MEMBERSHIP_RAW.toString(), now + PAYMENT_INTENT_TTL_MS, now, now);
  appendAudit(db, `user:${userId}`, 'usdg_membership_intent_created', { publicId, payer });
  return intentView(db.prepare(`SELECT * FROM usdg_payment_intents WHERE public_id=?`).get(publicId));
}

export function getUsdgPaymentIntent(db: DB, userId: number, publicId: string): UsdgPaymentIntentView | null {
  const row = db.prepare(
    `SELECT * FROM usdg_payment_intents WHERE public_id=? AND user_id=?`,
  ).get(publicId, userId);
  return row ? intentView(row) : null;
}

export interface ExactTransfer {
  logIndex: number;
  from: string;
  to: string;
  rawAmount: bigint;
}

/** Receipt logs are chain evidence; accept exactly one matching transfer. */
export function exactUsdgTransfer(logs: readonly any[], expected: {
  token: string;
  from: string;
  to: string;
  rawAmount: bigint;
}): ExactTransfer {
  const matches: ExactTransfer[] = [];
  for (const log of logs) {
    if (String(log.address).toLowerCase() !== expected.token.toLowerCase()) continue;
    if (String(log.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const from = `0x${String(log.topics[1]).slice(-40)}`.toLowerCase();
    const to = `0x${String(log.topics[2]).slice(-40)}`.toLowerCase();
    let raw: bigint;
    try { raw = BigInt(log.data); } catch { throw new Error('USDG transfer log has malformed data'); }
    if (from === expected.from.toLowerCase() && to === expected.to.toLowerCase() && raw === expected.rawAmount) {
      const logIndex = Number(log.logIndex);
      if (!Number.isInteger(logIndex) || logIndex < 0) throw new Error('USDG transfer log index is invalid');
      matches.push({ logIndex, from, to, rawAmount: raw });
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'transaction contains no exact membership USDG transfer'
      : 'transaction contains multiple matching membership transfers');
  }
  return matches[0]!;
}

export async function confirmUsdgPayment(
  db: DB,
  userId: number,
  publicId: string,
  txHash: string,
): Promise<{ intent: UsdgPaymentIntentView; confirmations: number; periodEnd?: number }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('invalid transaction hash');
  const normalizedHash = txHash.toLowerCase() as `0x${string}`;
  const intent = db.prepare(
    `SELECT * FROM usdg_payment_intents WHERE public_id=? AND user_id=?`,
  ).get(publicId, userId) as any;
  if (!intent) throw new Error('payment intent not found');
  if (intent.status === 'confirmed') {
    const subscription = latestSubscription(db, userId);
    return { intent: intentView(intent), confirmations: 12, periodEnd: subscription?.currentPeriodEnd };
  }
  if (intent.status === 'failed' || intent.status === 'expired') throw new Error(`payment intent is ${intent.status}`);
  if (intent.tx_hash && intent.tx_hash.toLowerCase() !== normalizedHash) {
    throw new Error('payment intent is already bound to a different transaction');
  }
  const claimed = db.prepare(
    `SELECT public_id FROM usdg_payment_intents WHERE lower(tx_hash)=? AND public_id<>?`,
  ).get(normalizedHash, publicId);
  if (claimed) throw new Error('transaction is already attached to another payment intent');
  db.prepare(
    `UPDATE usdg_payment_intents SET tx_hash=?, status='confirming', updated_at=? WHERE id=?`,
  ).run(normalizedHash, Date.now(), intent.id);

  const client = rhClient(ROBINHOOD_MAINNET_CHAIN_ID);
  const reportedChain = await client.getChainId();
  if (reportedChain !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error(`RPC reports wrong chain ${reportedChain}`);
  let receipt: any;
  try { receipt = await client.getTransactionReceipt({ hash: normalizedHash }); }
  catch {
    return { intent: intentView(db.prepare(`SELECT * FROM usdg_payment_intents WHERE id=?`).get(intent.id)), confirmations: 0 };
  }
  if (receipt.status !== 'success') {
    db.prepare(`UPDATE usdg_payment_intents SET status='failed', error=?, updated_at=? WHERE id=?`)
      .run('transaction reverted', Date.now(), intent.id);
    throw new Error('membership transaction reverted');
  }
  const transfer = exactUsdgTransfer(receipt.logs, {
    token: intent.token_address, from: intent.payer_address, to: intent.recipient_address,
    rawAmount: BigInt(intent.raw_amount),
  });
  const [head, block] = await Promise.all([
    client.getBlockNumber(),
    client.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error('membership receipt is not on the canonical block');
  }
  if (Number(block.timestamp) * 1000 > intent.expires_at) {
    db.prepare(`UPDATE usdg_payment_intents SET status='expired', error=?, updated_at=? WHERE id=?`)
      .run('transfer landed after payment intent expiry', Date.now(), intent.id);
    throw new Error('membership transfer landed after the payment intent expired');
  }
  const confirmations = Number(head - receipt.blockNumber + 1n);
  if (confirmations < 12) {
    return { intent: intentView(db.prepare(`SELECT * FROM usdg_payment_intents WHERE id=?`).get(intent.id)), confirmations };
  }

  const now = Date.now();
  const prior = latestSubscription(db, userId);
  const periodStart = Math.max(now, prior?.currentPeriodEnd ?? 0);
  const periodEnd = periodStart + MEMBERSHIP_PERIOD_MS;
  db.transaction(() => {
    const subscriptionId = upsertSubscription(db, {
      userId, provider: 'robinhood_usdg',
      providerSubscriptionId: `usdg:${normalizedHash}:${transfer.logIndex}`,
      providerPriceId: USDG.address.toLowerCase(), status: 'active',
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true, providerEventId: normalizedHash,
      providerEventCreatedAt: Number(block.timestamp) * 1000,
    });
    db.prepare(
      `INSERT INTO usdg_payment_receipts
       (intent_id,chain_id,tx_hash,log_index,block_number,block_hash,from_address,
        to_address,token_address,raw_amount,confirmations,confirmed_at)
       VALUES (?,4663,?,?,?,?,?,?,?,?,?,?)`,
    ).run(intent.id, normalizedHash, transfer.logIndex, receipt.blockNumber.toString(),
      receipt.blockHash.toLowerCase(), transfer.from, transfer.to, intent.token_address,
      transfer.rawAmount.toString(), confirmations, now);
    db.prepare(
      `INSERT INTO billing_payments
       (user_id,subscription_id,provider,provider_payment_id,status,currency,amount_micro,
        refunded_micro,provider_event_id,provider_event_created_at,occurred_at,created_at,updated_at)
       VALUES (?,?,'robinhood_usdg',?,'paid','USDG',20000000,0,?,?,?,?,?)`,
    ).run(userId, subscriptionId, `${normalizedHash}:${transfer.logIndex}`, normalizedHash,
      Number(block.timestamp) * 1000, Number(block.timestamp) * 1000, now, now);
    db.prepare(
      `UPDATE usdg_payment_intents SET status='confirmed', error=NULL, updated_at=? WHERE id=?`,
    ).run(now, intent.id);
    appendAudit(db, `user:${userId}`, 'usdg_membership_confirmed', {
      publicId, txHash: normalizedHash, logIndex: transfer.logIndex, confirmations, periodEnd,
    });
  })();
  return {
    intent: intentView(db.prepare(`SELECT * FROM usdg_payment_intents WHERE id=?`).get(intent.id)),
    confirmations, periodEnd,
  };
}

export interface UsdgReceiptAudit {
  checked: number;
  invalidated: number;
}

/** Re-check finalized payment blocks. A later reorg removes entitlement; it never mints a replacement. */
export async function auditUsdgPaymentReceipts(
  db: DB,
  blockHashAt: (blockNumber: bigint) => Promise<string | null> = async (blockNumber) => {
    const block = await rhClient(ROBINHOOD_MAINNET_CHAIN_ID).getBlock({ blockNumber });
    return block.hash ?? null;
  },
): Promise<UsdgReceiptAudit> {
  const receipts = db.prepare(
    `SELECT r.id,r.block_number,r.block_hash,i.id intent_id,i.user_id,i.tx_hash
     FROM usdg_payment_receipts r JOIN usdg_payment_intents i ON i.id=r.intent_id
     WHERE r.canonical=1 ORDER BY r.id`,
  ).all() as { id: number; block_number: string; block_hash: string; intent_id: number; user_id: number; tx_hash: string }[];
  let invalidated = 0;
  for (const receipt of receipts) {
    const observed = await blockHashAt(BigInt(receipt.block_number));
    const now = Date.now();
    if (observed?.toLowerCase() === receipt.block_hash.toLowerCase()) {
      db.prepare(`UPDATE usdg_payment_receipts SET last_checked_at=? WHERE id=?`).run(now, receipt.id);
      continue;
    }
    db.transaction(() => {
      db.prepare(
        `UPDATE usdg_payment_receipts
         SET canonical=0,last_checked_at=?,invalidated_at=? WHERE id=? AND canonical=1`,
      ).run(now, now, receipt.id);
      db.prepare(
        `UPDATE usdg_payment_intents SET status='failed',error='payment receipt was orphaned by a reorg',updated_at=?
         WHERE id=?`,
      ).run(now, receipt.intent_id);
      db.prepare(
        `UPDATE billing_payments SET status='void',updated_at=?
         WHERE provider='robinhood_usdg' AND provider_event_id=?`,
      ).run(now, receipt.tx_hash);
      db.prepare(
        `UPDATE subscriptions SET status='unpaid',updated_at=?
         WHERE user_id=? AND provider='robinhood_usdg' AND status IN ('active','trialing','granted')`,
      ).run(now, receipt.user_id);
      appendAudit(db, 'billing-reconciler', 'usdg_membership_receipt_reorged', {
        receiptId: receipt.id, txHash: receipt.tx_hash, expectedBlockHash: receipt.block_hash,
        observedBlockHash: observed,
      });
    })();
    invalidated++;
  }
  return { checked: receipts.length, invalidated };
}
