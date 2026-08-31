import type { DB } from '../db/db.js';
import { appendAudit } from '../audit/auditLog.js';
import type { Signer } from './signer.js';

/**
 * Serial worker: walks an approved epoch's payout_items queued -> signed -> sent.
 * Retries 3x with backoff, then parks the item as failed. Never re-sends an
 * item that already has a tx_sig.
 */
export class PayoutQueue {
  constructor(
    private db: DB,
    private signer: Signer,
  ) {}

  async distributeEpoch(epochId: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    const epoch = this.db
      .prepare(`SELECT id, status FROM payout_epochs WHERE id = ?`)
      .get(epochId) as { id: number; status: string } | undefined;
    if (!epoch) throw new Error(`epoch ${epochId} not found`);
    if (epoch.status !== 'approved') throw new Error(`epoch ${epochId} is ${epoch.status}, not approved`);

    this.db.prepare(`UPDATE payout_epochs SET status = 'distributing' WHERE id = ?`).run(epochId);
    appendAudit(this.db, 'payout-queue', 'distribute_start', { epochId });

    const items = this.db
      .prepare(
        `SELECT id, address, amount_micro FROM payout_items
         WHERE epoch_id = ? AND status IN ('queued','failed') AND tx_sig IS NULL
         ORDER BY id ASC`,
      )
      .all(epochId) as { id: number; address: string; amount_micro: number }[];

    let done = 0;
    for (const item of items) {
      await this.sendItem(item);
      done++;
      onProgress?.(done, items.length);
    }

    const remaining = this.db
      .prepare(`SELECT COUNT(*) AS n FROM payout_items WHERE epoch_id = ? AND status != 'sent'`)
      .get(epochId) as { n: number };
    const finalStatus = remaining.n === 0 ? 'done' : 'distributing';
    this.db.prepare(`UPDATE payout_epochs SET status = ? WHERE id = ?`).run(finalStatus, epochId);
    appendAudit(this.db, 'payout-queue', 'distribute_end', {
      epochId,
      sent: done,
      unsent: remaining.n,
    });
  }

  private async sendItem(item: { id: number; address: string; amount_micro: number }): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.db
          .prepare(`UPDATE payout_items SET status = 'signed', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
          .run(Date.now(), item.id);
        const { txSig } = await this.signer.send(item.address, item.amount_micro);
        this.db
          .prepare(`UPDATE payout_items SET status = 'sent', tx_sig = ?, updated_at = ? WHERE id = ?`)
          .run(txSig, Date.now(), item.id);
        return;
      } catch (e) {
        this.db
          .prepare(`UPDATE payout_items SET status = 'failed', updated_at = ? WHERE id = ?`)
          .run(Date.now(), item.id);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        else appendAudit(this.db, 'payout-queue', 'item_failed', { itemId: item.id, error: String(e) });
      }
    }
  }
}
