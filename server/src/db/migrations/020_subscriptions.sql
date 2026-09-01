-- Real product billing is deliberately separate from ledger_entries, which is
-- the demo-credit economy. No row in these tables represents trading capital.

CREATE TABLE billing_customers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  product_code TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL UNIQUE,
  provider_price_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'incomplete','incomplete_expired','trialing','active','past_due',
    'canceled','unpaid','paused','granted'
  )),
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  last_provider_event_id TEXT,
  provider_event_created_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id, product_code, updated_at DESC);
CREATE INDEX idx_subscriptions_period_end ON subscriptions(status, current_period_end);

CREATE TABLE billing_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing','processed','failed')),
  error TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE(provider, provider_event_id)
);

CREATE TABLE billing_notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  kind TEXT NOT NULL CHECK (kind IN ('renewal_5d','payment_failed')),
  period_end INTEGER NOT NULL,
  recipient TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','blocked','failed')),
  provider_ref TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subscription_id, kind, period_end)
);
CREATE INDEX idx_billing_notifications_state ON billing_notifications(state, updated_at);

-- Invoice outcomes are revenue evidence, not credits and not trading funds.
-- Entitlement still comes from subscription state, never from this table.
CREATE TABLE billing_payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid','failed','void','refunded','partially_refunded')),
  currency TEXT NOT NULL,
  amount_micro INTEGER NOT NULL CHECK (amount_micro >= 0),
  refunded_micro INTEGER NOT NULL DEFAULT 0 CHECK (refunded_micro >= 0),
  provider_event_id TEXT NOT NULL,
  provider_event_created_at INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, provider_payment_id)
);
CREATE INDEX idx_billing_payments_user ON billing_payments(user_id, occurred_at DESC);
