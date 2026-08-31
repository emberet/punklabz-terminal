-- THE INTERN.
--
-- An agent that reads crypto Twitter and posts its own thoughts. Two things
-- make that safe enough to build:
--
--  1. Everything it reads is UNTRUSTED DATA. Crypto Twitter contains text
--     written specifically to manipulate models; "ignore previous instructions"
--     is ordinary content there. Ingested text is stored and labelled as data,
--     never treated as instruction.
--
--  2. Every candidate it produces is logged HERE — published or blocked, with
--     the model's verbatim output and the exact set of numbers it was allowed
--     to use. The block log is public. If the filter is doing nothing, that is
--     visible; if it is catching things, that is visible too.
--
-- Additive only — safe on the live prod DB.

CREATE TABLE intern_reads (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,      -- the platform's own id, for dedupe
  author_handle TEXT NOT NULL,
  -- UNTRUSTED. Never interpolated into a system prompt, never followed.
  body TEXT NOT NULL,
  metrics_json TEXT NOT NULL,            -- likes/reposts/replies as the API reported
  fetched_at INTEGER NOT NULL,
  posted_at INTEGER,
  topic TEXT
);
CREATE INDEX idx_intern_reads_fetched ON intern_reads(fetched_at);

-- EVERY CANDIDATE. Blocked ones are the point of this table.
CREATE TABLE intern_posts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('post','reply','quote')),
  -- exactly what the model produced, before any filtering
  draft TEXT NOT NULL,
  -- the measured figures it was handed; the filter allows no other number
  allowed_numbers_json TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('published','blocked','shadow')),
  blocked_rules_json TEXT,               -- which rules fired, by name
  published_id TEXT,                     -- the platform's id, when published
  in_reply_to TEXT,
  prediction_id INTEGER REFERENCES agent_predictions(id),
  audit_hash TEXT NOT NULL,
  ts_published INTEGER
);
CREATE INDEX idx_intern_posts_ts ON intern_posts(ts);
CREATE INDEX idx_intern_posts_verdict ON intern_posts(verdict, ts);

-- QUOTA, RECONCILED AGAINST THE PLATFORM'S OWN HEADERS.
-- Our count and theirs disagreeing by more than a little means one of us is
-- wrong about what we have already done, which is a reason to stop.
CREATE TABLE intern_quota (
  id INTEGER PRIMARY KEY,
  window_start INTEGER NOT NULL,
  reads_used INTEGER NOT NULL DEFAULT 0,
  posts_used INTEGER NOT NULL DEFAULT 0,
  reads_reported INTEGER,                -- from the platform's rate-limit headers
  posts_reported INTEGER,
  drift_pct REAL,
  halted INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO intern_quota (window_start, updated_at)
VALUES (strftime('%s','now') * 1000, strftime('%s','now') * 1000);

CREATE TABLE intern_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- SHADOW is the default and the only mode this build ships enabled: every
  -- candidate is generated, filtered and logged, and nothing is published.
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('off','shadow','live')),
  shadow_started_at INTEGER,
  max_posts_per_day INTEGER NOT NULL DEFAULT 6,
  read_budget_per_month INTEGER NOT NULL DEFAULT 8000,
  updated_at INTEGER NOT NULL
);
INSERT INTO intern_config (id, mode, shadow_started_at, updated_at)
VALUES (1, 'shadow', strftime('%s','now') * 1000, strftime('%s','now') * 1000);
