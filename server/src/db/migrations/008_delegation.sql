-- NON-CUSTODIAL DELEGATION. A user lets a bot trade THEIR money.
--
-- PunkLabz never holds key material and never holds funds. What lives here is a
-- public address, an opaque reference to a signer held inside the provider, and
-- the caps the user chose. Nothing in this schema can sign anything.
--
-- Additive only — safe on the live prod DB.

CREATE TABLE delegation_grants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bot_id INTEGER NOT NULL REFERENCES bots(id),

  provider TEXT NOT NULL DEFAULT 'privy' CHECK (provider IN ('privy','none')),
  provider_user_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,          -- 0x…, public, checksummed
  chain_id INTEGER NOT NULL,             -- 8453 Base, 84532 Base Sepolia
  session_signer_id TEXT,                -- provider handle. NOT a key.
  policy_id TEXT,                        -- provider-side policy with the same caps
  provider_revoked_at INTEGER,

  -- caps: the USER chooses these, clamped by the ceiling in force at grant time
  per_trade_cap_micro INTEGER NOT NULL CHECK (per_trade_cap_micro >= 0),
  daily_cap_micro INTEGER NOT NULL CHECK (daily_cap_micro >= 0),
  cumulative_cap_micro INTEGER NOT NULL CHECK (cumulative_cap_micro >= 0),
  max_open_notional_micro INTEGER NOT NULL DEFAULT 0,
  max_slippage_bps INTEGER NOT NULL DEFAULT 50,

  -- the ceiling that applied when this grant was signed, frozen for any dispute
  ceiling_tier INTEGER NOT NULL,
  ceiling_per_trade_micro INTEGER NOT NULL,
  ceiling_cumulative_micro INTEGER NOT NULL,
  ceiling_evidence_json TEXT NOT NULL,

  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','paused','revoked','expired','exhausted')),
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT,

  consent_text_hash TEXT NOT NULL,       -- exact terms the user agreed to
  consent_signature TEXT,                -- the user's own signature over those terms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_grants_user ON delegation_grants(user_id, status);
CREATE INDEX idx_grants_bot ON delegation_grants(bot_id, status);
CREATE UNIQUE INDEX idx_grants_live ON delegation_grants(user_id, bot_id, wallet_address)
  WHERE status IN ('pending','active','paused');

-- a grant that names no token can buy nothing
CREATE TABLE delegation_tokens (
  grant_id INTEGER NOT NULL REFERENCES delegation_grants(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,           -- lowercased
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('base','quote')),
  PRIMARY KEY (grant_id, chain_id, token_address, role)
);

-- THE USAGE LEDGER. Spend-against-cap is enforced from this table, never from a
-- number a client sent. Reserve-then-settle so an in-flight order consumes cap
-- before a concurrent intent can double-spend it.
CREATE TABLE delegation_usage (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES delegation_grants(id),
  intent_id TEXT NOT NULL,
  order_id INTEGER REFERENCES live_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('reserved','settled','released')),
  amount_micro INTEGER NOT NULL,         -- released rows are negative
  instrument_id TEXT NOT NULL,
  token_address TEXT,
  ts INTEGER NOT NULL,
  note TEXT
);
CREATE UNIQUE INDEX idx_usage_intent_kind ON delegation_usage(intent_id, kind);
CREATE INDEX idx_usage_grant_ts ON delegation_usage(grant_id, ts);

CREATE TABLE delegation_events (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES delegation_grants(id),
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,                   -- created|activated|paused|resumed|revoked|expired|exhausted|cap_denied
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  audit_hash TEXT
);
CREATE INDEX idx_delegation_events ON delegation_events(grant_id, ts);

-- THE SYSTEM CEILING. Versioned; rises only on measured evidence.
CREATE TABLE delegation_ceiling (
  id INTEGER PRIMARY KEY,
  tier INTEGER NOT NULL,
  per_trade_cap_micro INTEGER NOT NULL,
  cumulative_cap_micro INTEGER NOT NULL,
  daily_cap_micro INTEGER NOT NULL,
  max_grants_per_user INTEGER NOT NULL,
  max_total_delegated_micro INTEGER NOT NULL,
  externally_audited INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
INSERT INTO delegation_ceiling
  (tier, per_trade_cap_micro, cumulative_cap_micro, daily_cap_micro,
   max_grants_per_user, max_total_delegated_micro, evidence_json, effective_at, actor)
VALUES (0, 0, 0, 0, 0, 0,
  '{"reason":"no live track record — delegation is built, testable, and inert"}',
  strftime('%s','now') * 1000, 'migration');

ALTER TABLE live_orders ADD COLUMN delegation_grant_id INTEGER REFERENCES delegation_grants(id);
CREATE INDEX idx_live_orders_grant ON live_orders(delegation_grant_id, created_at);

-- a delegated bot books to its OWN execution account: one user's NAV never mixes
-- with the house book, same principle as migration 007
ALTER TABLE execution_accounts ADD COLUMN delegation_grant_id INTEGER
  REFERENCES delegation_grants(id);
CREATE UNIQUE INDEX idx_exec_accounts_grant ON execution_accounts(delegation_grant_id)
  WHERE delegation_grant_id IS NOT NULL;
