import { randomUUID } from 'node:crypto';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import type { DB } from '../db/db.js';
import type { TradingSigner } from './signing/signer.js';

interface ChainClient {
  getTransactionCount(args: { address: Address; blockTag: 'pending' }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  getTransactionReceipt(args: { hash: Hex }): Promise<any>;
}

export interface CoordinatedTransaction {
  orderId: number;
  accountId: number;
  purpose: 'allowance' | 'swap';
  idempotencyKey: string;
  chainId: number;
  walletAddress: string;
  to: string;
  data: string;
  value: bigint;
  gas: bigint;
  /** hard deadline for quote-backed transactions; approval transactions omit it */
  expiresAt?: number;
}

export interface CoordinatedResult {
  transactionId: number;
  hash: string;
  nonce: number;
}

const walletQueues = new Map<string, Promise<void>>();

/**
 * Owns the dangerous gap between signing and recording a transaction hash.
 * The signed bytes and their locally-computed hash are durable before the RPC
 * sees them, so recovery can only rebroadcast the same bounded transaction.
 */
export class TransactionCoordinator {
  private readonly ownerId = `proc_${process.pid}_${randomUUID()}`;

  constructor(
    private db: DB,
    private signer: TradingSigner,
    private client: ChainClient,
  ) {}

  submit(req: CoordinatedTransaction): Promise<CoordinatedResult> {
    const wallet = req.walletAddress.toLowerCase();
    const prior = walletQueues.get(wallet) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => turn);
    walletQueues.set(wallet, queued);
    return prior.then(async () => {
      try {
        return await this.submitLocked(req);
      } finally {
        release();
        if (walletQueues.get(wallet) === queued) walletQueues.delete(wallet);
      }
    });
  }

  private acquireLease(wallet: string): void {
    const now = Date.now();
    const expiresAt = now + 60_000;
    const ok = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT owner_id, expires_at FROM execution_leases WHERE wallet_address = ?`)
        .get(wallet) as { owner_id: string; expires_at: number } | undefined;
      if (existing && existing.owner_id !== this.ownerId && existing.expires_at > now) return false;
      this.db.prepare(
        `INSERT INTO execution_leases (wallet_address, owner_id, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(wallet_address) DO UPDATE SET owner_id=excluded.owner_id,
           expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
      ).run(wallet, this.ownerId, expiresAt, now);
      return true;
    })();
    if (!ok) throw new Error('another execution process holds the signer lease');
  }

  private async submitLocked(req: CoordinatedTransaction): Promise<CoordinatedResult> {
    const wallet = req.walletAddress.toLowerCase();
    this.acquireLease(wallet);

    let row = this.db.prepare(`SELECT * FROM execution_transactions WHERE idempotency_key = ?`)
      .get(req.idempotencyKey) as any;
    if (row) {
      if (row.signed_tx_hash && row.state === 'broadcast') {
        return { transactionId: row.id, hash: row.signed_tx_hash, nonce: row.nonce };
      }
      if (row.signed_payload && row.signed_tx_hash && row.state === 'signed') {
        return this.broadcastExisting(row);
      }
      if (row.state !== 'prepared') throw new Error(`transaction is ${row.state}`);
    } else {
      const other = this.db.prepare(
        `SELECT id, idempotency_key, state FROM execution_transactions
         WHERE wallet_address=? AND state IN ('prepared','signed','broadcast','unknown') LIMIT 1`,
      ).get(wallet) as { id: number; idempotency_key: string; state: string } | undefined;
      if (other) {
        throw new Error(`wallet has unresolved ${other.state} transaction ${other.id}; recover it before allocating a nonce`);
      }
      const [nonce, fees] = await Promise.all([
        this.client.getTransactionCount({ address: getAddress(wallet) as Address, blockTag: 'pending' }),
        this.client.estimateFeesPerGas(),
      ]);
      const priority = fees.maxPriorityFeePerGas ?? 1_000_000n;
      const maxFee = fees.maxFeePerGas ?? priority * 2n;
      const now = Date.now();
      const info = this.db.prepare(
        `INSERT INTO execution_transactions
          (order_id, execution_account_id, purpose, idempotency_key, chain_id, wallet_address,
           nonce, to_address, data, value_wei, gas_limit, max_fee_per_gas,
           max_priority_fee_per_gas, expires_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      ).run(req.orderId, req.accountId, req.purpose, req.idempotencyKey, req.chainId, wallet,
        nonce, req.to.toLowerCase(), req.data, String(req.value), String(req.gas), String(maxFee),
        String(priority), req.expiresAt ?? null, now, now);
      row = this.db.prepare(`SELECT * FROM execution_transactions WHERE id = ?`)
        .get(Number(info.lastInsertRowid));
    }

    return this.signPrepared(row);
  }

  private async signPrepared(row: any): Promise<CoordinatedResult> {
    if (row.expires_at && Date.now() >= row.expires_at) {
      this.db.prepare(`UPDATE execution_transactions SET state='unknown', error=?, updated_at=? WHERE id=?`)
        .run('validated quote expired before signing', Date.now(), row.id);
      throw new Error('validated quote expired before signing; transaction was not broadcast');
    }
    const raw = await this.signer.signTransaction({
      chainId: row.chain_id,
      to: row.to_address,
      data: row.data,
      value: BigInt(row.value_wei),
      gas: BigInt(row.gas_limit),
      nonce: row.nonce,
      maxFeePerGas: BigInt(row.max_fee_per_gas),
      maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas),
      intentId: row.idempotency_key,
    });
    const hash = keccak256(raw as Hex);
    const expired = row.expires_at && Date.now() >= row.expires_at;
    this.db.prepare(
      `UPDATE execution_transactions SET signed_tx_hash = ?, signed_payload = ?, state = ?, error=?, updated_at = ?
       WHERE id = ? AND state = 'prepared'`,
    ).run(hash, raw, expired ? 'unknown' : 'signed',
      expired ? 'validated quote expired while signing; signed bytes were not broadcast' : null,
      Date.now(), row.id);
    if (expired) throw new Error('validated quote expired while signing; transaction was not broadcast');
    row = this.db.prepare(`SELECT * FROM execution_transactions WHERE id = ?`).get(row.id);
    return this.broadcastExisting(row);
  }

  private async broadcastExisting(row: any): Promise<CoordinatedResult> {
    if (row.expires_at && Date.now() >= row.expires_at) {
      this.db.prepare(`UPDATE execution_transactions SET state='unknown', error=?, updated_at=? WHERE id=?`)
        .run('validated quote expired before broadcast; signed bytes retained for review', Date.now(), row.id);
      throw new Error('validated quote expired before broadcast; transaction was not sent');
    }
    const expected = row.signed_tx_hash as string;
    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: row.signed_payload as Hex });
      if (hash.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`RPC returned hash ${hash}, locally signed hash is ${expected}`);
      }
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes('already known') && !message.includes('known transaction')) throw error;
    }
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE execution_transactions SET state='broadcast', broadcast_attempts=broadcast_attempts+1,
         updated_at=? WHERE id=?`,
      ).run(now, row.id);
      if (row.purpose === 'swap') {
        this.db.prepare(
          `UPDATE live_orders SET state='pending', tx_ref=?, venue_order_id=?, submitted_at=COALESCE(submitted_at,?),
           updated_at=? WHERE id=?`,
        ).run(expected, expected, now, now, row.order_id);
      }
    })();
    return { transactionId: row.id, hash: expected, nonce: row.nonce };
  }

  /** Recover exact signed bytes; never synthesize a new intent or nonce. */
  async recover(): Promise<{ recovered: number; unresolved: number }> {
    const rows = this.db.prepare(
      `SELECT * FROM execution_transactions WHERE state IN ('prepared','signed','broadcast','unknown') ORDER BY id`,
    ).all() as any[];
    let recovered = 0;
    let unresolved = 0;
    for (const row of rows) {
      if (row.state === 'prepared') {
        try {
          await this.signPrepared(row);
          recovered++;
        } catch (error) {
          this.db.prepare(`UPDATE execution_transactions SET error=?, updated_at=? WHERE id=?`)
            .run(String(error).slice(0, 300), Date.now(), row.id);
          unresolved++;
        }
        continue;
      }
      if (!row.signed_tx_hash || !row.signed_payload) {
        this.db.prepare(`UPDATE execution_transactions SET state='unknown', error=?, updated_at=? WHERE id=?`)
          .run('missing durable signed transaction payload', Date.now(), row.id);
        unresolved++;
        continue;
      }
      try {
        const receipt = await this.client.getTransactionReceipt({ hash: row.signed_tx_hash as Hex }).catch(() => null);
        if (receipt) {
          this.db.transaction(() => {
            this.db.prepare(
              `UPDATE execution_transactions SET state=?, block_number=?, block_hash=?, updated_at=? WHERE id=?`,
            ).run(receipt.status === 'success' ? 'confirmed' : 'reverted', Number(receipt.blockNumber),
              receipt.blockHash, Date.now(), row.id);
            if (row.purpose === 'swap') {
              this.db.prepare(
                `UPDATE live_orders SET state='pending', tx_ref=?, venue_order_id=?,
                 submitted_at=COALESCE(submitted_at,?), updated_at=? WHERE id=?`,
              ).run(row.signed_tx_hash, row.signed_tx_hash, Date.now(), Date.now(), row.order_id);
            }
          })();
          recovered++;
          continue;
        }
        if (row.state === 'signed') {
          await this.broadcastExisting(row);
          recovered++;
        } else if (Date.now() - row.created_at > 15 * 60_000) {
          this.db.prepare(`UPDATE execution_transactions SET state='unknown', error=?, updated_at=? WHERE id=?`)
            .run('broadcast transaction absent from RPC for more than 15 minutes', Date.now(), row.id);
          unresolved++;
        }
      } catch (error) {
        this.db.prepare(`UPDATE execution_transactions SET error=?, updated_at=? WHERE id=?`)
          .run(String(error).slice(0, 300), Date.now(), row.id);
        unresolved++;
      }
    }
    return { recovered, unresolved };
  }
}
