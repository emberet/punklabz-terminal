import { existsSync, readFileSync } from 'node:fs';
import { PrivyClient } from '@privy-io/node';
import { getAddress, isAddress } from 'viem';
import type { DB } from '../db/db.js';
import { seedUser } from '../billing/ledger.js';
import { appendAudit } from '../audit/auditLog.js';

function appSecret(): string {
  const file = process.env.PRIVY_APP_SECRET_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  if (process.env.NODE_ENV === 'production') return '';
  return process.env.PRIVY_APP_SECRET ?? '';
}

function uniqueName(db: DB, preferred: string): string {
  const base = preferred.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32) || 'operator';
  let candidate = base;
  let suffix = 1;
  while (db.prepare(`SELECT 1 FROM users WHERE display_name=?`).get(candidate)) {
    candidate = `${base.slice(0, 27)}-${suffix++}`;
  }
  return candidate;
}

export interface VerifiedPrivyIdentity {
  providerUserId: string;
  email: string | null;
  wallets: string[];
}

export async function verifyPrivyIdentityToken(identityToken: string): Promise<VerifiedPrivyIdentity> {
  const appId = process.env.PRIVY_APP_ID ?? '';
  const secret = appSecret();
  if (!appId || !secret) throw new Error('Privy authentication is not configured');
  if (!identityToken || identityToken.length > 20_000) throw new Error('invalid Privy identity token');
  let user: any;
  try {
    user = await new PrivyClient({ appId, appSecret: secret }).users().get({ id_token: identityToken });
  } catch {
    throw new Error('Privy identity verification failed');
  }
  if (!String(user?.id ?? '').startsWith('did:privy:')) throw new Error('Privy identity did not contain a valid user ID');
  const emailAccount = (user.linked_accounts ?? []).find((account: any) => account?.type === 'email');
  const email = typeof emailAccount?.address === 'string' ? emailAccount.address.trim().toLowerCase() : null;
  const wallets = [...new Set((user.linked_accounts ?? [])
    .filter((account: any) => account?.type === 'wallet' && account?.chain_type === 'ethereum' && isAddress(account?.address))
    .map((account: any) => getAddress(account.address).toLowerCase()))] as string[];
  if (!email && wallets.length === 0) throw new Error('Privy identity has no verified email or EVM wallet');
  return { providerUserId: user.id, email, wallets };
}

/** Link a verified Privy DID conservatively; conflicting legacy identities are never auto-merged. */
export function bindPrivyIdentity(
  db: DB,
  identity: VerifiedPrivyIdentity,
  currentUserId?: number,
): { userId: number; created: boolean } {
  const existingIdentity = db.prepare(
    `SELECT user_id FROM privy_identities WHERE provider_user_id=?`,
  ).get(identity.providerUserId) as { user_id: number } | undefined;
  if (existingIdentity && currentUserId && existingIdentity.user_id !== currentUserId) {
    throw new Error('this Privy identity is already linked to another PunkLabz account');
  }
  let userId = currentUserId ?? existingIdentity?.user_id;
  const matched = new Set<number>();
  if (identity.email) {
    const row = db.prepare(`SELECT id FROM users WHERE email=?`).get(identity.email) as { id: number } | undefined;
    if (row) matched.add(row.id);
  }
  for (const wallet of identity.wallets) {
    const row = db.prepare(`SELECT id FROM users WHERE lower(wallet_address)=?`).get(wallet) as { id: number } | undefined;
    if (row) matched.add(row.id);
    const linked = db.prepare(
      `SELECT user_id FROM user_wallet_links WHERE chain_id=4663 AND address=? AND revoked_at IS NULL`,
    ).get(wallet) as { user_id: number } | undefined;
    if (linked) matched.add(linked.user_id);
  }
  if (matched.size > 1 || (userId && [...matched].some((id) => id !== userId))) {
    throw new Error('Privy identity spans conflicting legacy accounts; operator review is required');
  }
  userId ??= [...matched][0];
  let created = false;
  if (!userId) {
    const name = uniqueName(db, identity.email?.split('@')[0] ?? identity.wallets[0]!.slice(2, 10));
    const info = db.prepare(
      `INSERT INTO users (email,wallet_address,display_name,is_admin,created_at) VALUES (?,?,?,0,?)`,
    ).run(identity.email, identity.wallets[0] ?? null, name, Date.now());
    userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    created = true;
  }
  const row = db.prepare(`SELECT email,wallet_address FROM users WHERE id=?`).get(userId) as any;
  db.transaction(() => {
    if (!row.email && identity.email) db.prepare(`UPDATE users SET email=? WHERE id=?`).run(identity.email, userId);
    if (!row.wallet_address && identity.wallets[0]) {
      db.prepare(`UPDATE users SET wallet_address=? WHERE id=?`).run(identity.wallets[0], userId);
    }
    for (const wallet of identity.wallets) {
      db.prepare(
        `INSERT INTO user_wallet_links
           (user_id,chain_id,address,kind,provider,provider_user_id,verified_at,revoked_at)
         VALUES (?,4663,?,'privy_identity','privy',?,?,NULL)
         ON CONFLICT(chain_id,address) DO UPDATE SET
           user_id=excluded.user_id,kind='privy_identity',provider='privy',
           provider_user_id=excluded.provider_user_id,verified_at=excluded.verified_at,revoked_at=NULL`,
      ).run(userId, wallet, identity.providerUserId, Date.now());
    }
    db.prepare(
      `INSERT INTO privy_identities (user_id,provider_user_id,linked_at,last_verified_at)
       VALUES (?,?,?,?)
       ON CONFLICT(provider_user_id) DO UPDATE SET last_verified_at=excluded.last_verified_at`,
    ).run(userId, identity.providerUserId, Date.now(), Date.now());
    appendAudit(db, `user:${userId}`, 'privy_identity_verified', {
      providerUserId: identity.providerUserId, walletCount: identity.wallets.length, created,
    });
  })();
  return { userId, created };
}
