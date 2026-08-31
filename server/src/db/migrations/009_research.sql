-- ALWAYS-ON RESEARCH.
--
-- The rule this schema exists to enforce: an LLM proposes text, and arithmetic
-- on RESOLVED OUTCOMES moves the weights. Nothing an agent says about itself
-- changes what the network believes; only a falsifiable claim that came true
-- or didn't.
--
-- Additive only — safe on the live prod DB.

-- what an agent noticed. Free text, never trusted as fact by anything else.
CREATE TABLE agent_observations (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,                   -- SCANNER | RISK CORE | MANAGER | INTERN | bot:<id>
  bot_id INTEGER REFERENCES bots(id),
  kind TEXT NOT NULL,                    -- regime | flow | risk | microstructure | social
  subject TEXT NOT NULL,                 -- the instrument or topic it is about
  body TEXT NOT NULL,
  inputs_json TEXT NOT NULL,             -- the measured numbers it was handed
  session_id INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_observations_agent_ts ON agent_observations(agent, ts);
CREATE INDEX idx_observations_subject ON agent_observations(subject, ts);

-- A FALSIFIABLE CLAIM. The resolution rule and the baseline are frozen when the
-- prediction opens, so nothing can be re-scored favourably after the fact.
CREATE TABLE agent_predictions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  bot_id INTEGER REFERENCES bots(id),
  observation_id INTEGER REFERENCES agent_observations(id),
  claim_kind TEXT NOT NULL,              -- edge_survives | direction | regime_persists | volatility | attention_decay
  subject TEXT NOT NULL,
  -- the claim, as a probability the stated outcome happens
  probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  resolution_rule TEXT NOT NULL,         -- human-readable, frozen at open
  resolver TEXT NOT NULL,                -- which resolver function settles it
  baseline_json TEXT NOT NULL,           -- the measured state at open
  horizon_ms INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  resolves_at INTEGER NOT NULL,
  -- resolution
  resolved_at INTEGER,
  outcome INTEGER,                       -- 1 happened, 0 did not, NULL unresolved
  outcome_json TEXT,                     -- the measured state at resolution
  brier REAL,                            -- (probability - outcome)^2
  void_reason TEXT                       -- set when it could not be settled honestly
);
CREATE INDEX idx_predictions_due ON agent_predictions(resolves_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_predictions_agent ON agent_predictions(agent, claim_kind, resolved_at);

-- A REBUILDABLE CACHE. Every row here is recomputable from agent_predictions;
-- if it ever disagrees, the predictions win.
CREATE TABLE agent_scores (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  claim_kind TEXT NOT NULL,
  resolved_n INTEGER NOT NULL,
  mean_brier REAL NOT NULL,
  hit_rate REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  UNIQUE (agent, claim_kind)
);

-- THE CONFIDENCE WEIGHTS. Versioned, and every row must be recomputable from
-- its own inputs_json — a weight nobody can reproduce is a weight nobody can
-- audit.
CREATE TABLE confidence_weights (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  component TEXT NOT NULL,               -- strategy | regime | liquidity | cost | confirmation
  base_weight REAL NOT NULL,
  weight REAL NOT NULL,
  shrunk_skill REAL NOT NULL,
  resolved_n INTEGER NOT NULL,
  inputs_json TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  UNIQUE (version, component)
);

-- the base weights in force today, recorded as version 1 so the cold start is
-- itself an auditable row rather than a constant buried in code
INSERT INTO confidence_weights
  (version, component, base_weight, weight, shrunk_skill, resolved_n, inputs_json, computed_at)
VALUES
  (1, 'strategy',     0.30, 0.30, 0, 0, '{"reason":"cold start — no resolved predictions"}', strftime('%s','now') * 1000),
  (1, 'regime',       0.25, 0.25, 0, 0, '{"reason":"cold start — no resolved predictions"}', strftime('%s','now') * 1000),
  (1, 'liquidity',    0.15, 0.15, 0, 0, '{"reason":"cold start — no resolved predictions"}', strftime('%s','now') * 1000),
  (1, 'cost',         0.15, 0.15, 0, 0, '{"reason":"cold start — no resolved predictions"}', strftime('%s','now') * 1000),
  (1, 'confirmation', 0.15, 0.15, 0, 0, '{"reason":"cold start — no resolved predictions"}', strftime('%s','now') * 1000);

CREATE TABLE research_sessions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                    -- standup | debate | retro | scan
  topic TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  turns INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);

-- THE BUDGET. Measured spend, not estimated: every row is written from the
-- usage the API actually reported.
CREATE TABLE llm_budget (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,                   -- YYYY-MM
  caller TEXT NOT NULL,                  -- forum | discussion | intern | manager | agent_chat
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  UNIQUE (month, caller)
);

-- PERSISTENT RATE LIMITS. The bug this replaces: forum.ts kept its last-post
-- timestamp in a module-level variable, so a crash loop reset it on every
-- restart and could spam the room and the API bill without bound.
CREATE TABLE agent_rate_limits (
  key TEXT PRIMARY KEY,                  -- e.g. forum:autopost, intern:publish
  last_at INTEGER NOT NULL,
  count_window_start INTEGER NOT NULL,
  count_in_window INTEGER NOT NULL DEFAULT 0
);
