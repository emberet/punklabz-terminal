-- OPERATOR CLEARANCE MOVES TO THE WALLET.
--
-- Before this, `users.is_admin` was set at registration for any email listed
-- in ADMIN_EMAILS, and every authorization check read that column. A column is
-- a bad place to keep an authorization decision: a migration, a seed script, a
-- restored backup or one careless UPDATE can set it, and nothing about the row
-- records who decided or why.
--
-- Clearance is now DERIVED on every request from the wallet bound to the
-- session, compared against the single configured operator address. The column
-- survives only as a human-readable mirror.
--
-- So: revoke everything the column currently grants. Any account that should
-- have the Control Room gets it back the moment it connects the operator
-- wallet and signs the nonce — and not before.
UPDATE users SET is_admin = 0;

-- Wallet addresses are EVM now (Robinhood Chain), stored lowercase so that
-- comparison never depends on checksum casing. No rows are affected today —
-- the wallet column is empty — but normalising here means the constraint holds
-- for anything that arrives later.
UPDATE users SET wallet_address = lower(wallet_address) WHERE wallet_address IS NOT NULL;

-- Nonces are single-use and short-lived; anything outstanding across this
-- change is for the old signing scheme and must not be redeemable.
DELETE FROM wallet_nonces;
