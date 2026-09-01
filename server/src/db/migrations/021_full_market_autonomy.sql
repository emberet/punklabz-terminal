-- Full-market Robinhood Chain autonomy foundation.
--
-- The registry is mutable operational data. Execution must instead point at
-- an immutable snapshot whose content hash is also bound to the signer policy.
-- Installing this migration disables autonomy because the existing two-token
-- policy cannot authorize a larger snapshot by implication.

CREATE TABLE rh_universe_snapshots (
  id INTEGER PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 4663),
  content_hash TEXT NOT NULL UNIQUE,
  asset_count INTEGER NOT NULL CHECK (asset_count > 1),
  directed_pair_count INTEGER NOT NULL CHECK (directed_pair_count >= 2),
  state TEXT NOT NULL CHECK (state IN ('draft','active','retired')),
  registry_run_id INTEGER REFERENCES rh_registry_runs(id),
  policy_hash TEXT,
  policy_bundle_json TEXT,
  policy_ids_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE UNIQUE INDEX idx_rh_one_active_universe
  ON rh_universe_snapshots(state) WHERE state = 'active';

CREATE TABLE rh_universe_assets (
  snapshot_id INTEGER NOT NULL REFERENCES rh_universe_snapshots(id),
  symbol TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  asset_class TEXT NOT NULL,
  multiplier TEXT NOT NULL,
  trading_capabilities_json TEXT NOT NULL,
  registry_verified_at INTEGER NOT NULL,
  policy_reference_price_usd TEXT,
  policy_raw_cap TEXT,
  PRIMARY KEY (snapshot_id, contract_address),
  UNIQUE (snapshot_id, symbol)
);
CREATE INDEX idx_rh_universe_symbol ON rh_universe_assets(snapshot_id, symbol);

CREATE TABLE operator_jurisdiction_attestations (
  id INTEGER PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  not_us_person INTEGER NOT NULL CHECK (not_us_person IN (0,1)),
  not_restricted_jurisdiction INTEGER NOT NULL CHECK (not_restricted_jurisdiction IN (0,1)),
  signature TEXT NOT NULL,
  signed_message TEXT NOT NULL,
  actor TEXT NOT NULL,
  attested_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_jurisdiction_current
  ON operator_jurisdiction_attestations(wallet_address, attested_at DESC);

CREATE TABLE rh_reference_price_bars (
  symbol TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  multiplier TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  last_generated_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, minute_ts)
);

CREATE TABLE pair_sweep_runs (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES rh_universe_snapshots(id),
  state TEXT NOT NULL CHECK (state IN ('running','complete','failed','stale','rate_limited')),
  expected_pairs INTEGER NOT NULL,
  attempted_pairs INTEGER NOT NULL DEFAULT 0,
  quoted_pairs INTEGER NOT NULL DEFAULT 0,
  eligible_pairs INTEGER NOT NULL DEFAULT 0,
  rejected_pairs INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  UNIQUE(snapshot_id, started_at)
);
CREATE UNIQUE INDEX idx_pair_sweep_single_running
  ON pair_sweep_runs(state) WHERE state = 'running';

CREATE TABLE pair_sweep_candidates (
  id INTEGER PRIMARY KEY,
  sweep_id INTEGER NOT NULL REFERENCES pair_sweep_runs(id),
  sell_symbol TEXT NOT NULL,
  buy_symbol TEXT NOT NULL,
  sell_contract TEXT NOT NULL,
  buy_contract TEXT NOT NULL,
  sell_amount_raw TEXT NOT NULL,
  buy_amount_raw TEXT,
  source_value_micro INTEGER NOT NULL,
  reference_edge_bps TEXT,
  indicative_quote_json TEXT,
  rejection_code TEXT,
  rejection_detail TEXT,
  rank_score TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(sweep_id, sell_contract, buy_contract)
);
CREATE INDEX idx_pair_candidates_rank ON pair_sweep_candidates(sweep_id, rejection_code, rank_score DESC);

CREATE TABLE trading_council_runs (
  id INTEGER PRIMARY KEY,
  sweep_id INTEGER NOT NULL REFERENCES pair_sweep_runs(id),
  candidate_id INTEGER REFERENCES pair_sweep_candidates(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('running','approved','rejected','failed','budget_blocked')),
  model_score INTEGER,
  approvals INTEGER NOT NULL DEFAULT 0,
  risk_approved INTEGER NOT NULL DEFAULT 0,
  manager_approved INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  sources_json TEXT NOT NULL DEFAULT '[]',
  proposal_json TEXT,
  rejection_reason TEXT,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_council_runs_day ON trading_council_runs(started_at, state);

CREATE TABLE trading_council_votes (
  id INTEGER PRIMARY KEY,
  council_run_id INTEGER NOT NULL REFERENCES trading_council_runs(id),
  role TEXT NOT NULL CHECK (role IN ('trader','market_scout','intern_news','risk_core','manager')),
  approved INTEGER NOT NULL CHECK (approved IN (0,1)),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rationale TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(council_run_id, role)
);

CREATE TABLE full_market_nav_snapshots (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  total_micro INTEGER NOT NULL,
  settlement_micro INTEGER NOT NULL,
  holdings_json TEXT NOT NULL,
  valuation_method TEXT NOT NULL CHECK (valuation_method='executable_min_to_usdg'),
  ts INTEGER NOT NULL
);
CREATE INDEX idx_full_market_nav_account ON full_market_nav_snapshots(execution_account_id, ts);

-- Raw integer quantities are canonical for all new entries. The legacy
-- decimal qty_delta remains populated only for compatibility with the current
-- WETH/USDG views while they are retired.
ALTER TABLE execution_asset_ledger ADD COLUMN chain_id INTEGER;
ALTER TABLE execution_asset_ledger ADD COLUMN contract_address TEXT;
ALTER TABLE execution_asset_ledger ADD COLUMN decimals INTEGER;
ALTER TABLE execution_asset_ledger ADD COLUMN raw_delta TEXT;
ALTER TABLE execution_asset_ledger ADD COLUMN snapshot_hash TEXT;
ALTER TABLE balance_snapshots ADD COLUMN contract_address TEXT;
ALTER TABLE balance_snapshots ADD COLUMN decimals INTEGER;
ALTER TABLE balance_snapshots ADD COLUMN venue_raw TEXT;
ALTER TABLE balance_snapshots ADD COLUMN ledger_raw TEXT;
CREATE UNIQUE INDEX idx_asset_ledger_raw_log
  ON execution_asset_ledger(execution_account_id, tx_ref, log_index, contract_address, event_type)
  WHERE tx_ref IS NOT NULL AND log_index IS NOT NULL AND contract_address IS NOT NULL;

ALTER TABLE live_orders ADD COLUMN sell_symbol TEXT;
ALTER TABLE live_orders ADD COLUMN buy_symbol TEXT;
ALTER TABLE live_orders ADD COLUMN sell_contract TEXT;
ALTER TABLE live_orders ADD COLUMN buy_contract TEXT;
ALTER TABLE live_orders ADD COLUMN sell_decimals INTEGER;
ALTER TABLE live_orders ADD COLUMN buy_decimals INTEGER;
ALTER TABLE live_orders ADD COLUMN sell_amount_raw TEXT;
ALTER TABLE live_orders ADD COLUMN min_buy_amount_raw TEXT;
ALTER TABLE live_orders ADD COLUMN quote_observed_at INTEGER;
ALTER TABLE live_orders ADD COLUMN eth_reference_usd TEXT;
ALTER TABLE live_orders ADD COLUMN registry_snapshot_hash TEXT;
ALTER TABLE live_orders ADD COLUMN council_run_id INTEGER REFERENCES trading_council_runs(id);
ALTER TABLE live_orders ADD COLUMN reconciliation_status TEXT;

ALTER TABLE live_config ADD COLUMN authorized_capital_usdg TEXT;
ALTER TABLE live_config ADD COLUMN authorized_capital_set_at INTEGER;
ALTER TABLE live_config ADD COLUMN active_universe_hash TEXT;
ALTER TABLE live_config ADD COLUMN expected_signer_policy_hash TEXT;
ALTER TABLE live_config ADD COLUMN observed_signer_policy_hash TEXT;
ALTER TABLE live_config ADD COLUMN full_market_autonomy INTEGER NOT NULL DEFAULT 0;

UPDATE live_config
SET autonomy_enabled = 0,
    full_market_autonomy = 0,
    halted = 1,
    halt_reason = 'full-market safety migration installed; snapshot policy, attestation, sweep, reconciliation, and explicit arm required',
    updated_at = strftime('%s','now') * 1000
WHERE id = 1;
