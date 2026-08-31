-- PunkLabz Terminal schema. Money and token quantities: INTEGER micro-units
-- (1 USD = 1e6 micro-USD). Floats appear only in candles/indicator inputs.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  wallet_address TEXT UNIQUE,
  display_name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (email IS NOT NULL OR wallet_address IS NOT NULL)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE wallet_nonces (
  wallet_address TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE bots (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id),  -- NULL = house bot
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('house','quant')),
  strategy_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  cloned_from_bot_id INTEGER REFERENCES bots(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','paused')),
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE bot_accounts (
  bot_id INTEGER PRIMARY KEY REFERENCES bots(id),
  cash_micro INTEGER NOT NULL,
  initial_balance_micro INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  symbol TEXT NOT NULL,
  qty REAL NOT NULL,
  avg_entry REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX idx_positions_bot_open ON positions(bot_id, closed_at);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type TEXT NOT NULL CHECK (type IN ('market','limit')),
  qty REAL NOT NULL,
  limit_price REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','canceled')),
  created_at INTEGER NOT NULL,
  filled_at INTEGER
);
CREATE INDEX idx_orders_open ON orders(status, symbol) WHERE status = 'open';

CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  order_id INTEGER REFERENCES orders(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee_micro INTEGER NOT NULL DEFAULT 0,
  realized_pnl_micro INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_trades_bot_ts ON trades(bot_id, ts);
CREATE INDEX idx_trades_ts ON trades(ts);

CREATE TABLE candles (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  ts INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (symbol, interval, ts)
);

CREATE TABLE pump_tokens (
  mint TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  launched_at INTEGER NOT NULL,
  last_price_sol REAL,
  mcap_sol REAL,
  buys_60s INTEGER NOT NULL DEFAULT 0,
  vol_60s REAL NOT NULL DEFAULT 0,
  unique_buyers_60s INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bot_metrics (
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  ts INTEGER NOT NULL,
  equity_micro INTEGER NOT NULL,
  realized_pnl_micro INTEGER NOT NULL,
  unrealized_pnl_micro INTEGER NOT NULL,
  trade_count INTEGER NOT NULL,
  win_count INTEGER NOT NULL,
  PRIMARY KEY (bot_id, ts)
);

CREATE TABLE holder_snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mock','solana'))
);

CREATE TABLE holders (
  snapshot_id INTEGER NOT NULL REFERENCES holder_snapshots(id),
  address TEXT NOT NULL,
  balance INTEGER NOT NULL,   -- whole PunkLabz tokens
  PRIMARY KEY (snapshot_id, address)
);

CREATE TABLE payout_epochs (
  id INTEGER PRIMARY KEY,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  total_profit_micro INTEGER NOT NULL,
  eligible_supply INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES holder_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('computed','needs_review','approved','distributing','done')),
  inputs_hash TEXT NOT NULL,
  claude_summary TEXT,
  anomalies_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE payout_items (
  id INTEGER PRIMARY KEY,
  epoch_id INTEGER NOT NULL REFERENCES payout_epochs(id),
  address TEXT NOT NULL,
  balance INTEGER NOT NULL,
  amount_micro INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','signed','sent','failed')),
  tx_sig TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_payout_items_epoch ON payout_items(epoch_id);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('seed','fee_creation','fee_reuse','fee_trade_tax')),
  amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  ref_bot_id INTEGER,
  ref_trade_id INTEGER UNIQUE,
  memo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_ledger_debit ON ledger_entries(debit_account);
CREATE INDEX idx_ledger_credit ON ledger_entries(credit_account);

CREATE TABLE builder_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  messages_json TEXT NOT NULL DEFAULT '[]',
  draft_config_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deployed','abandoned')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
