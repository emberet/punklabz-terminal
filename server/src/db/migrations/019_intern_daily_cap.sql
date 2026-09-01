-- Operator-requested capacity increase. This changes the hard ceiling only;
-- the autonomous Intern keeps its durable two-hour cycle cooldown.
UPDATE intern_config
SET max_posts_per_day = 69,
    updated_at = strftime('%s','now') * 1000
WHERE id = 1;
