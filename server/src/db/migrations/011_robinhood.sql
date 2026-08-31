-- ROBINHOOD CHAIN FOUNDATION.
--
-- The asset registry, the multiplier history, corporate actions, and the
-- reference-price cache. Everything here is sourced from two places that can
-- disagree — the official asset API and the chain itself — and the schema is
-- built so a disagreement is recorded rather than resolved by preference.
--
-- Additive only — safe on the live prod DB.

-- THE REGISTRY. One row per verified instrument. An asset that has not been
-- confirmed onchain cannot reach LIVE_ALLOWED, however good the API looks.
CREATE TABLE rh_assets (
  symbol TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,          -- lowercased
  asset_id TEXT,                           -- Robinhood's own opaque id
  name TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('CRYPTO','STOCK_TOKEN','ETF_TOKEN','RWA','STABLECOIN')),
  -- NEVER assume: stock tokens are 18, USDG is 6. Read, don't guess.
  decimals INTEGER NOT NULL,
  isin TEXT,
  status TEXT NOT NULL,
  tradable INTEGER NOT NULL DEFAULT 0,
  trading_capabilities_json TEXT,

  -- multiplier as reported by the API and as read from the token
  multiplier TEXT NOT NULL DEFAULT '1.000000000000000000',
  onchain_multiplier TEXT,
  pending_multiplier TEXT,
  pending_effective_at INTEGER,

  -- verification: every one of these must hold before live routing
  verified_onchain INTEGER NOT NULL DEFAULT 0,
  verification_json TEXT,
  eligibility TEXT NOT NULL DEFAULT 'RESEARCH_ONLY'
    CHECK (eligibility IN ('BLOCKED','RESEARCH_ONLY','SHADOW_ONLY','CANARY_ALLOWED','LIVE_ALLOWED')),
  eligibility_reason TEXT,

  first_seen_at INTEGER NOT NULL,
  last_verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract_address)
);
CREATE UNIQUE INDEX idx_rh_assets_symbol ON rh_assets(chain_id, symbol);
CREATE INDEX idx_rh_assets_eligibility ON rh_assets(eligibility, tradable);
CREATE INDEX idx_rh_assets_class ON rh_assets(asset_class);

-- EVERY multiplier we have ever observed, with the instant it took effect.
-- Backtests read this; using today's multiplier for a historical bar turns a
-- stock split into a fabricated 300% overnight gain.
CREATE TABLE rh_multiplier_history (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  multiplier TEXT NOT NULL,
  effective_at INTEGER NOT NULL,           -- unix SECONDS, as the contract reports
  observed_at INTEGER NOT NULL,            -- when WE saw it (ms)
  source TEXT NOT NULL,                    -- api | onchain | corporate_action
  UNIQUE (symbol, effective_at, multiplier)
);
CREATE INDEX idx_rh_multiplier_lookup ON rh_multiplier_history(symbol, effective_at);

CREATE TABLE rh_corporate_actions (
  id TEXT PRIMARY KEY,                     -- Robinhood's own id
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  symbol TEXT NOT NULL,
  contract_address TEXT,
  chain_id INTEGER,
  process_date TEXT,                       -- YYYY-MM-DD
  process_ts INTEGER,
  details_json TEXT NOT NULL,
  -- an instrument with an unresolved action is not tradable, full stop
  blocks_trading INTEGER NOT NULL DEFAULT 0,
  acknowledged_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_rh_ca_symbol ON rh_corporate_actions(symbol, status);
CREATE INDEX idx_rh_ca_blocking ON rh_corporate_actions(blocks_trading, status);

-- Reference prices are CACHED WITH THEIR OWN TIMESTAMP. The API stamps every
-- quote with generatedAt; staleness is measured against that, never against
-- when we happened to fetch it.
CREATE TABLE rh_reference_prices (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  currency TEXT NOT NULL,
  is_trading_halt INTEGER NOT NULL DEFAULT 0,
  daily_volume REAL,
  daily_high REAL,
  daily_low REAL,
  generated_at INTEGER NOT NULL,           -- from the API payload
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_rh_prices_symbol_ts ON rh_reference_prices(symbol, generated_at);

-- Every registry refresh, so "REGISTRY STALE" is a fact with a timestamp
-- rather than a mood.
CREATE TABLE rh_registry_runs (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  assets_seen INTEGER NOT NULL DEFAULT 0,
  assets_verified INTEGER NOT NULL DEFAULT 0,
  assets_rejected INTEGER NOT NULL DEFAULT 0,
  mismatches_json TEXT,
  duration_ms INTEGER,
  error TEXT
);

-- Chain-level health, so the Sentinel has somewhere to write what it saw.
CREATE TABLE rh_chain_health (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  rpc_label TEXT NOT NULL,
  ok INTEGER NOT NULL,
  block_number INTEGER,
  latency_ms INTEGER,
  chain_id_reported INTEGER,
  error TEXT
);
CREATE INDEX idx_rh_health_ts ON rh_chain_health(ts);

-- Gas is ETH on this chain and it is a hard trading precondition, so it gets
-- real configuration rather than a constant buried in the risk engine.
ALTER TABLE live_config ADD COLUMN gas_reserve_critical_usd REAL NOT NULL DEFAULT 3;
ALTER TABLE live_config ADD COLUMN gas_reserve_warning_usd REAL NOT NULL DEFAULT 5;
ALTER TABLE live_config ADD COLUMN primary_chain_id INTEGER NOT NULL DEFAULT 4663;
