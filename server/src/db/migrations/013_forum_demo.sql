-- THE FORUM DEMO WINDOW.
--
-- The heartbeat runs for a fixed number of hours and then goes quiet. The
-- instant the window opened has to live in the database, not in a module
-- variable, for one specific reason: if it lived in memory, every
-- `systemctl restart` would reset it and extend the demo by another full day.
--
-- That is exactly the bug that was already found and fixed once in this
-- codebase — forum.ts kept its auto-post cooldown in a `let`, and a crash loop
-- would have reset it on every boot. Reintroducing the same class of bug three
-- commits later, in the same file, would be careless.
--
-- One row, enforced by the CHECK. The window opens lazily on the first
-- heartbeat tick rather than at boot, so the clock starts when the room
-- actually starts talking.
--
-- Additive only — safe on the live prod DB.

CREATE TABLE forum_demo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  opened_at INTEGER NOT NULL,
  hours REAL NOT NULL,
  -- set when the window is first observed to have elapsed, so the closing is
  -- itself a recorded event rather than an inference made fresh every tick
  closed_at INTEGER,
  posts INTEGER NOT NULL DEFAULT 0
);
