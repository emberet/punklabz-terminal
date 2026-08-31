import type { DB } from '../../db/db.js';

// Revocation has to beat the gap between risk approval and venue submission.
// A DB read at that moment is a round-trip we may not have; this is an
// in-process set checked synchronously right before placeOrder().
//
// It fails CLOSED: an id it has never heard of is treated as revoked until the
// cache has been hydrated, so a cold cache cannot green-light a spend.

export class RevocationCacheImpl {
  private revoked = new Set<number>();
  private hydrated = false;

  hydrate(db: DB): void {
    const rows = db
      .prepare(`SELECT id FROM delegation_grants WHERE status IN ('revoked','expired','exhausted','paused')`)
      .all() as { id: number }[];
    this.revoked = new Set(rows.map((r) => r.id));
    this.hydrated = true;
  }

  revoke(grantId: number): void {
    this.revoked.add(grantId);
  }

  restore(grantId: number): void {
    this.revoked.delete(grantId);
  }

  /** true when this grant must not spend right now */
  isRevoked(grantId: number): boolean {
    if (!this.hydrated) return true; // fail closed
    return this.revoked.has(grantId);
  }

  size(): number {
    return this.revoked.size;
  }

  isHydrated(): boolean {
    return this.hydrated;
  }
}

export const revocationCache = new RevocationCacheImpl();
