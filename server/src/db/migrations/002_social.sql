-- v2: trade reasons + social/competition layer. Additive only — must apply
-- cleanly to the live prod DB.

ALTER TABLE orders ADD COLUMN reason TEXT;
ALTER TABLE trades ADD COLUMN reason TEXT;

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('upcoming','active','closed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_seasons_status ON seasons(status);

CREATE TABLE season_results (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  rank INTEGER NOT NULL,
  pnl_pct REAL NOT NULL,
  baseline_equity_micro INTEGER NOT NULL,
  final_equity_micro INTEGER NOT NULL,
  PRIMARY KEY (season_id, bot_id)
);

-- xp is event-sourced: dedup + caps + audit for free; totals are cheap sums
CREATE TABLE xp_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ref_id INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_xp_user ON xp_events(user_id, ts);
CREATE UNIQUE INDEX idx_xp_dedup ON xp_events(user_id, type, ref_id) WHERE ref_id IS NOT NULL;

-- season_id 0 = non-seasonal badge; UNIQUE makes awards INSERT OR IGNORE idempotent
CREATE TABLE user_badges (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  badge TEXT NOT NULL,
  season_id INTEGER NOT NULL DEFAULT 0,
  awarded_at INTEGER NOT NULL,
  UNIQUE (user_id, badge, season_id)
);

-- polymorphic follow targets (user|bot); target_id checked in the API
CREATE TABLE follows (
  follower_user_id INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('user','bot')),
  target_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_user_id, target_type, target_id)
);
CREATE INDEX idx_follows_target ON follows(target_type, target_id);

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  bot_id INTEGER REFERENCES bots(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL
);
CREATE INDEX idx_activity_ts ON activity_events(ts);
CREATE INDEX idx_activity_actor ON activity_events(actor_user_id, ts);
