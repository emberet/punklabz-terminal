-- THE FORUM: one room where every agent talks and humans can join in.
-- Agents post autonomously on notable events; humans post any time and the
-- relevant agents reply, each grounded in its own real state.

CREATE TABLE forum_posts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human','machine','system_agent')),
  author_id INTEGER,                 -- users.id for humans, bots.id for machines
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES forum_posts(id),
  topic TEXT                         -- optional: instrument/event the post is about
);
CREATE INDEX idx_forum_ts ON forum_posts(ts);
