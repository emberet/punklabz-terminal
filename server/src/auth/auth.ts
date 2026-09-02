import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { getAddress, isAddress, verifyMessage } from 'viem';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { seedUser } from '../billing/ledger.js';
import { appendAudit } from '../audit/auditLog.js';
import { recordWalletLink } from '../billing/usdgMembership.js';

const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const NONCE_TTL_MS = 5 * 60_000;

export interface AuthUser {
  id: number;
  email: string | null;
  walletAddress: string | null;
  displayName: string;
  isAdmin: boolean;
  sessionCreatedAt: number;
  sessionAuthMethod: string;
}

export interface LinkedWallet {
  address: string;
  userId: number;
  merged: boolean;
}

export interface LinkedEmail {
  email: string;
  userId: number;
  merged: boolean;
}

/**
 * ADMIN IS COMPUTED, NEVER STORED.
 *
 * The `users.is_admin` column still exists for display, but nothing reads it
 * for authorization. Clearance is derived on every request from the wallet
 * bound to the session, compared against the one configured operator address.
 *
 * That matters because a stored flag has a dozen ways to become wrong — a
 * migration, a seed script, a bad UPDATE, a restored backup — and every one of
 * them silently grants the Control Room. A derived check has exactly one way
 * to be true: the session's user proved control of that address by signing a
 * single-use nonce.
 */
export function isAdminWallet(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  return walletAddress.toLowerCase() === config.adminWallet;
}

/** lowercase for storage and comparison; checksummed only for display */
function normalizeAddress(address: string): string {
  if (!isAddress(address)) throw new Error('not a valid EVM address');
  return getAddress(address).toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DB, userId: number, authMethod: 'email' | 'wallet' | 'privy' = 'email'): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, auth_method) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS, authMethod);
  return token;
}

export function destroySession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function userFromSession(db: DB, token: string | undefined): AuthUser | null {
  if (!token) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.wallet_address, u.display_name, u.is_admin, s.created_at,
              s.expires_at, s.token_hash, s.auth_method
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now) as
    | { id: number; email: string | null; wallet_address: string | null; display_name: string; is_admin: number; created_at: number; expires_at: number; token_hash: string; auth_method: string }
    | undefined;
  if (!row) return null;
  // sliding expiry: extend when past halfway
  if (row.expires_at - now < SESSION_TTL_MS / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL_MS, row.token_hash);
  }
  return {
    id: row.id,
    email: row.email,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    // derived from the bound wallet, not from row.is_admin
    isAdmin: isAdminWallet(row.wallet_address),
    sessionCreatedAt: row.created_at,
    sessionAuthMethod: row.auth_method,
  };
}

// ── email/password ───────────────────────────────────────────────────────────

export async function registerEmail(db: DB, email: string, password: string, displayName: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('invalid email');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (exists) throw new Error('email already registered');
  // display names are cosmetic (users are id-addressed) but keep new ones unique
  const requestedName = displayName.slice(0, 40) || normalized.split('@')[0];
  const nameTaken = db.prepare('SELECT id FROM users WHERE display_name = ?').get(requestedName);
  if (nameTaken) throw new Error('display name already taken');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  // An email address grants nothing. Clearance comes from connecting the
  // operator wallet and signing for it.
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(normalized, hash, requestedName, Date.now());
    const userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    return userId;
  });
  return tx();
}

export async function loginEmail(db: DB, email: string, password: string): Promise<number> {
  const row = db
    .prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as { id: number; password_hash: string | null } | undefined;
  if (!row?.password_hash) throw new Error('invalid credentials');
  const ok = await argon2.verify(row.password_hash, password);
  if (!ok) throw new Error('invalid credentials');
  return row.id;
}

// ── wallet (EVM personal_sign) ───────────────────────────────────────────────
//
// Robinhood Chain is EVM, so wallet identity is an EVM address proved with an
// EIP-191 personal_sign over a server-issued single-use nonce. The nonce is
// deleted the moment it is consumed, so a captured signature cannot be
// replayed, and it carries the address it was issued for so a signature for
// one wallet cannot be presented as another's.

export function issueNonce(db: DB, walletAddress: string): string {
  const address = normalizeAddress(walletAddress);
  const nonce = randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO wallet_nonces (wallet_address, nonce, expires_at) VALUES (?, ?, ?)')
    .run(address, nonce, Date.now() + NONCE_TTL_MS);
  return nonce;
}

export function loginMessage(nonce: string): string {
  return [
    'PunkLabz Terminal',
    '',
    'Sign this message to prove you control this wallet.',
    'This is a signature, not a transaction: it costs nothing and moves nothing.',
    '',
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Consume the nonce and verify the signature came from `walletAddress`.
 * Returns the proven address. Every path that binds a wallet goes through it.
 */
async function proveWallet(db: DB, walletAddress: string, signature: string): Promise<string> {
  const address = normalizeAddress(walletAddress);
  const row = db
    .prepare('SELECT nonce, expires_at FROM wallet_nonces WHERE wallet_address = ?')
    .get(address) as { nonce: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) throw new Error('nonce expired, request a new one');
  // single-use, deleted before verification so a failed attempt burns it too
  db.prepare('DELETE FROM wallet_nonces WHERE wallet_address = ?').run(address);

  const ok = await verifyMessage({
    address: getAddress(address),
    message: loginMessage(row.nonce),
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!ok) throw new Error('signature verification failed');
  return address;
}

/**
 * Collapse a duplicate identity into its canonical user after both identities
 * have been proven by the caller. The target profile survives; owned records,
 * sessions, and sign-in methods move with the source.
 */
function mergeUserInto(db: DB, sourceUserId: number, targetUserId: number, reason: string): void {
  if (sourceUserId === targetUserId) return;
  const source = db.prepare(
    'SELECT id, email, wallet_address FROM users WHERE id = ?',
  ).get(sourceUserId) as { id: number; email: string | null; wallet_address: string | null } | undefined;
  const target = db.prepare(
    'SELECT id, email, wallet_address FROM users WHERE id = ?',
  ).get(targetUserId) as { id: number; email: string | null; wallet_address: string | null } | undefined;
  if (!source || !target) throw new Error('account no longer exists');
  if (source.email && target.email && source.email !== target.email) {
    throw new Error('both accounts already have different emails; automatic merge refused');
  }
  if (source.wallet_address && target.wallet_address && source.wallet_address !== target.wallet_address) {
    throw new Error('both accounts already have different wallets; automatic merge refused');
  }

  const liveGrantConflict = db.prepare(
    `SELECT 1
     FROM delegation_grants source
     JOIN delegation_grants target
       ON target.user_id = ? AND target.bot_id = source.bot_id
      AND lower(target.wallet_address) = lower(source.wallet_address)
      AND target.status IN ('pending','active','paused')
     WHERE source.user_id = ? AND source.status IN ('pending','active','paused')
     LIMIT 1`,
  ).get(targetUserId, sourceUserId);
  if (liveGrantConflict) {
    throw new Error('accounts have conflicting live delegation grants; automatic merge refused');
  }
  const providerIdentityConflict = db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM privy_identities WHERE user_id=?)
       AND EXISTS (SELECT 1 FROM privy_identities WHERE user_id=?)`,
  ).get(sourceUserId, targetUserId);
  if (providerIdentityConflict) {
    throw new Error('both accounts have Privy identities; automatic merge refused');
  }
  const billingCustomerConflict = db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM billing_customers WHERE user_id=?)
       AND EXISTS (SELECT 1 FROM billing_customers WHERE user_id=?)`,
  ).get(sourceUserId, targetUserId);
  if (billingCustomerConflict) {
    throw new Error('both accounts have billing provider identities; automatic merge refused');
  }

  const sourceAccount = `user:${sourceUserId}`;
  const targetAccount = `user:${targetUserId}`;
  const targetHasSeed = !!db.prepare(
    `SELECT 1 FROM ledger_entries
     WHERE type='seed' AND credit_account=? LIMIT 1`,
  ).get(targetAccount);

  const tx = db.transaction(() => {
    // A person receives one demo signup credit. Move every legitimate debit
    // and credit, but leave a duplicate source seed in its retired ledger.
    db.prepare('UPDATE ledger_entries SET debit_account=? WHERE debit_account=?')
      .run(targetAccount, sourceAccount);
    db.prepare(
      `UPDATE ledger_entries SET credit_account=?
       WHERE credit_account=? AND NOT (?=1 AND type='seed')`,
    ).run(targetAccount, sourceAccount, targetHasSeed ? 1 : 0);

    db.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE bots SET owner_user_id=? WHERE owner_user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE builder_sessions SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE delegation_grants SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE user_wallet_links SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE usdg_payment_intents SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE wallet_screening_results SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE bot_live_wallets SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE privy_identities SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE billing_customers SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE subscriptions SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE billing_payments SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE billing_notifications SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare(`UPDATE forum_posts SET author_id=? WHERE author_kind='human' AND author_id=?`)
      .run(targetUserId, sourceUserId);
    db.prepare('UPDATE forum_moderation_events SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE activity_events SET actor_user_id=? WHERE actor_user_id=?').run(targetUserId, sourceUserId);

    db.prepare(
      `INSERT OR IGNORE INTO user_badges (user_id, badge, season_id, awarded_at)
       SELECT ?, badge, season_id, awarded_at FROM user_badges WHERE user_id=?`,
    ).run(targetUserId, sourceUserId);
    db.prepare('DELETE FROM user_badges WHERE user_id=?').run(sourceUserId);

    db.prepare(
      `INSERT OR IGNORE INTO xp_events (user_id, type, amount, ref_id, ts)
       SELECT ?, type, amount, ref_id, ts FROM xp_events WHERE user_id=?`,
    ).run(targetUserId, sourceUserId);
    db.prepare('DELETE FROM xp_events WHERE user_id=?').run(sourceUserId);

    // Follows are polymorphic and only the follower has a foreign key, so
    // merge outgoing and incoming edges explicitly and remove self-follows.
    db.prepare(
      `INSERT OR IGNORE INTO follows (follower_user_id, target_type, target_id, created_at)
       SELECT ?, target_type,
              CASE WHEN target_type='user' AND target_id=? THEN ? ELSE target_id END,
              created_at
       FROM follows
       WHERE follower_user_id=?
         AND NOT (target_type='user' AND target_id IN (?, ?))`,
    ).run(targetUserId, sourceUserId, targetUserId, sourceUserId, sourceUserId, targetUserId);
    db.prepare(
      `INSERT OR IGNORE INTO follows (follower_user_id, target_type, target_id, created_at)
       SELECT follower_user_id, 'user', ?, created_at
       FROM follows
       WHERE target_type='user' AND target_id=?
         AND follower_user_id NOT IN (?, ?)`,
    ).run(targetUserId, sourceUserId, sourceUserId, targetUserId);
    db.prepare('DELETE FROM follows WHERE follower_user_id=?').run(sourceUserId);
    db.prepare(`DELETE FROM follows WHERE target_type='user' AND target_id=?`).run(sourceUserId);
    db.prepare(
      `DELETE FROM follows WHERE follower_user_id=? AND target_type='user' AND target_id=?`,
    ).run(targetUserId, targetUserId);

    const walletAddress = target.wallet_address ?? source.wallet_address;
    db.prepare('DELETE FROM users WHERE id=?').run(sourceUserId);
    db.prepare('UPDATE users SET wallet_address=?, is_admin=? WHERE id=?')
      .run(walletAddress, isAdminWallet(walletAddress) ? 1 : 0, targetUserId);
    appendAudit(db, `user:${targetUserId}`, 'account_merge', {
      sourceUserId,
      targetUserId,
      reason,
      walletAddress,
    });
  });
  tx();
}

/** Sign in with a wallet, creating the account on first sight. */
export async function verifyWallet(db: DB, walletAddress: string, signature: string): Promise<number> {
  const address = await proveWallet(db, walletAddress, signature);

  const existing = db.prepare('SELECT id FROM users WHERE wallet_address = ?').get(address) as
    | { id: number }
    | undefined;
  if (existing) {
    syncAdminMirror(db, existing.id, address);
    recordWalletLink(db, existing.id, address);
    return existing.id;
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (wallet_address, display_name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(address, `${address.slice(0, 6)}…${address.slice(-4)}`, isAdminWallet(address) ? 1 : 0, Date.now());
    const userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    recordWalletLink(db, userId, address);
    return userId;
  });
  return tx();
}

/**
 * Bind a wallet to an account that already signed in some other way. This is
 * how an email operator reaches the Control Room: prove the wallet, and
 * clearance follows from the address itself.
 */
export async function linkWallet(
  db: DB,
  userId: number,
  walletAddress: string,
  signature: string,
): Promise<LinkedWallet> {
  const address = await proveWallet(db, walletAddress, signature);

  const current = db.prepare(
    'SELECT email, password_hash, wallet_address FROM users WHERE id = ?',
  ).get(userId) as
    | { email: string | null; password_hash: string | null; wallet_address: string | null }
    | undefined;
  if (!current) throw new Error('account no longer exists');
  if (current?.wallet_address && current.wallet_address !== address) {
    throw new Error('this account already has a wallet connected — disconnect it first');
  }

  const owner = db.prepare(
    'SELECT id, email FROM users WHERE wallet_address = ?',
  ).get(address) as { id: number; email: string | null } | undefined;
  let merged = false;
  if (owner && owner.id !== userId) {
    if (!current.email || !current.password_hash) {
      throw new Error('sign in to an email account before combining this wallet profile');
    }
    if (owner.email) {
      throw new Error('that wallet belongs to an account with its own email; automatic merge refused');
    }
    mergeUserInto(db, owner.id, userId, 'wallet linked to authenticated email account');
    merged = true;
  }

  db.prepare('UPDATE users SET wallet_address = ? WHERE id = ?').run(address, userId);
  recordWalletLink(db, userId, address);
  syncAdminMirror(db, userId, address);
  return { address, userId, merged };
}

/** Unbind. Losing the operator wallet loses Control Room access, by design. */
export function unlinkWallet(db: DB, userId: number): void {
  const row = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(userId) as
    | { email: string | null; password_hash: string | null }
    | undefined;
  if (!row?.email || !row.password_hash) {
    throw new Error('add an email and password first — otherwise this would lock you out of the account');
  }
  const wallet = db.prepare(`SELECT wallet_address address FROM users WHERE id=?`).get(userId) as
    { address: string | null } | undefined;
  db.transaction(() => {
    db.prepare('UPDATE users SET wallet_address = NULL, is_admin = 0 WHERE id = ?').run(userId);
    if (wallet?.address) {
      db.prepare(
        `UPDATE user_wallet_links SET revoked_at=?
         WHERE user_id=? AND chain_id=4663 AND lower(address)=lower(?) AND revoked_at IS NULL`,
      ).run(Date.now(), userId, wallet.address);
    }
  })();
}

/** Add email/password to a wallet-first account, so it has a second way in. */
export async function linkEmail(
  db: DB,
  userId: number,
  email: string,
  password: string,
): Promise<LinkedEmail> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('invalid email');
  if (password.length < 8) throw new Error('password must be at least 8 characters');

  const current = db.prepare('SELECT email, wallet_address FROM users WHERE id = ?').get(userId) as
    | { email: string | null; wallet_address: string | null }
    | undefined;
  if (!current) throw new Error('account no longer exists');
  if (current?.email && current.email !== normalized) {
    throw new Error('this account already has an email');
  }

  const taken = db.prepare(
    'SELECT id, password_hash, wallet_address FROM users WHERE email = ?',
  ).get(normalized) as
    | { id: number; password_hash: string | null; wallet_address: string | null }
    | undefined;
  if (taken && taken.id !== userId) {
    if (!current.wallet_address) {
      throw new Error('connect a wallet before combining it with an existing email account');
    }
    if (taken.wallet_address && taken.wallet_address !== current.wallet_address) {
      throw new Error('that email account already has a different wallet; automatic merge refused');
    }
    if (!taken.password_hash || !await argon2.verify(taken.password_hash, password).catch(() => false)) {
      throw new Error('invalid credentials');
    }
    mergeUserInto(db, userId, taken.id, 'email linked to authenticated wallet account');
    syncAdminMirror(db, taken.id, current.wallet_address);
    return { email: normalized, userId: taken.id, merged: true };
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(normalized, hash, userId);
  return { email: normalized, userId, merged: false };
}

/**
 * Keep users.is_admin as a readable mirror of the derived truth. Nothing
 * authorizes off this column — see isAdminWallet — but leaving it stale would
 * make the database lie to anyone reading it.
 */
function syncAdminMirror(db: DB, userId: number, walletAddress: string | null): void {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdminWallet(walletAddress) ? 1 : 0, userId);
}
