-- CRYPTO-ONLY AUTONOMY + ONCHAIN MEMBERSHIP.
--
-- This migration changes custody and execution authority, so it always lands
-- halted. Deployment is not an arm ceremony.

ALTER TABLE live_config ADD COLUMN executable_scope TEXT NOT NULL DEFAULT 'CRYPTO_CORE';

UPDATE live_config
SET full_market_autonomy = 0,
    autonomy_enabled = 0,
    halted = 1,
    halt_reason = 'crypto-only custody release installed; fresh policies, funding proof, route proof and reconciliation required',
    executable_scope = 'CRYPTO_CORE',
    updated_at = strftime('%s','now') * 1000
WHERE id = 1;

-- A user may prove more than one wallet. users.wallet_address remains the
-- primary login mirror; money flows use this normalized, auditable link table.
CREATE TABLE user_wallet_links (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL CHECK (chain_id = 4663),
  address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('external','privy_identity')),
  provider TEXT NOT NULL,
  provider_user_id TEXT,
  verified_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(chain_id, address),
  UNIQUE(user_id, chain_id, address)
);
CREATE INDEX idx_user_wallet_links_user ON user_wallet_links(user_id, revoked_at);

CREATE TABLE privy_identities (
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider_user_id TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO user_wallet_links
  (user_id, chain_id, address, kind, provider, verified_at)
SELECT id, 4663, lower(wallet_address), 'external', 'legacy_wallet_link', created_at
FROM users WHERE wallet_address IS NOT NULL;

-- One direct, exact USDG transfer buys one fixed membership period. The
-- intent is not money; only the finalized receipt can mint entitlement.
CREATE TABLE usdg_payment_intents (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 4663),
  token_address TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  raw_amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirming','confirmed','expired','failed')),
  tx_hash TEXT,
  error TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_usdg_intent_tx
  ON usdg_payment_intents(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE INDEX idx_usdg_intents_user ON usdg_payment_intents(user_id, created_at DESC);

CREATE TABLE usdg_payment_receipts (
  id INTEGER PRIMARY KEY,
  intent_id INTEGER NOT NULL UNIQUE REFERENCES usdg_payment_intents(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 4663),
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  raw_amount TEXT NOT NULL,
  confirmations INTEGER NOT NULL CHECK (confirmations >= 12),
  canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0,1)),
  last_checked_at INTEGER,
  invalidated_at INTEGER,
  confirmed_at INTEGER NOT NULL,
  UNIQUE(chain_id, tx_hash, log_index)
);

-- One custody boundary per live bot. Provider handles are opaque and are
-- never returned by public endpoints.
CREATE TABLE bot_live_wallets (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  execution_account_id INTEGER UNIQUE REFERENCES execution_accounts(id),
  provider TEXT NOT NULL CHECK (provider IN ('privy')),
  provider_user_id TEXT NOT NULL,
  wallet_id TEXT UNIQUE,
  wallet_address TEXT NOT NULL UNIQUE,
  session_signer_id TEXT,
  policy_id TEXT,
  chain_id INTEGER NOT NULL CHECK (chain_id = 4663),
  state TEXT NOT NULL CHECK (state IN ('provisioning','awaiting_funds','ready','active','paused','revoked','blocked')),
  screening_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (screening_status IN ('pending','clear','review','blocked','unavailable')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_bot_live_wallets_user ON bot_live_wallets(user_id, state);

-- User-owned machines are private in the public room unless their owner opts
-- them in. House machines remain eligible without this flag.
ALTER TABLE bots ADD COLUMN public_chat_opt_in INTEGER NOT NULL DEFAULT 0
  CHECK (public_chat_opt_in IN (0,1));

ALTER TABLE delegation_grants ADD COLUMN provider_wallet_id TEXT;
CREATE UNIQUE INDEX idx_delegation_provider_wallet
  ON delegation_grants(provider, provider_wallet_id)
  WHERE provider_wallet_id IS NOT NULL AND status IN ('pending','active','paused');

CREATE TABLE wallet_screening_results (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet_address TEXT NOT NULL,
  provider TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('clear','review','blocked','unavailable')),
  provider_ref TEXT,
  detail_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_wallet_screening_current
  ON wallet_screening_results(wallet_address, checked_at DESC);

CREATE TABLE manager_rebalance_runs (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  authorized_capital_micro INTEGER NOT NULL,
  reconciled_nav_micro INTEGER NOT NULL,
  reserve_micro INTEGER NOT NULL,
  allocatable_micro INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('computed','applied','blocked','failed')),
  inputs_json TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE manager_rebalance_items (
  run_id INTEGER NOT NULL REFERENCES manager_rebalance_runs(id) ON DELETE CASCADE,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  prior_allocation_micro INTEGER NOT NULL,
  target_allocation_micro INTEGER NOT NULL,
  applied_allocation_micro INTEGER NOT NULL,
  score_ppm INTEGER NOT NULL,
  close_only INTEGER NOT NULL CHECK (close_only IN (0,1)),
  evidence_json TEXT NOT NULL,
  PRIMARY KEY(run_id, bot_id)
);

-- Public-room content expires; its hash and moderation evidence survive the
-- text so incident review does not require retaining conversation forever.
ALTER TABLE forum_posts ADD COLUMN content_hash TEXT;
ALTER TABLE forum_posts ADD COLUMN expires_at INTEGER;
ALTER TABLE forum_posts ADD COLUMN deleted_at INTEGER;
ALTER TABLE forum_posts ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'accepted';

UPDATE forum_posts SET expires_at = ts + 2592000000 WHERE expires_at IS NULL;

CREATE TABLE forum_moderation_events (
  id INTEGER PRIMARY KEY,
  post_id INTEGER REFERENCES forum_posts(id),
  user_id INTEGER REFERENCES users(id),
  content_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('accepted','rejected','redacted','expired')),
  rules_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_forum_moderation_user ON forum_moderation_events(user_id, created_at DESC);
