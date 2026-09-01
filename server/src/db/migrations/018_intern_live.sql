-- Durable X publishing state. A process crash after the request leaves the row
-- in `publishing`; the next cycle halts instead of risking a duplicate post.
ALTER TABLE intern_posts ADD COLUMN publish_state TEXT NOT NULL DEFAULT 'not_attempted'
  CHECK (publish_state IN ('not_attempted','publishing','published','failed'));
ALTER TABLE intern_posts ADD COLUMN publish_attempted_at INTEGER;

UPDATE intern_posts
SET publish_state = CASE
  WHEN published_id IS NOT NULL THEN 'published'
  WHEN blocked_rules_json LIKE '%publish_failed%' THEN 'failed'
  ELSE 'not_attempted'
END;

CREATE UNIQUE INDEX idx_intern_posts_published_id
ON intern_posts(published_id) WHERE published_id IS NOT NULL;
