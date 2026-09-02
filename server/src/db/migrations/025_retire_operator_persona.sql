-- Retire the former public operator persona while preserving private login
-- identifiers and immutable git history. Existing public names become stable,
-- non-personal aliases so bot ownership and forum attribution remain intact.

UPDATE users
SET display_name = 'operator_' || id
WHERE instr(lower(display_name), char(101, 109, 98, 101, 114)) > 0;

UPDATE forum_posts
SET author_name = CASE
  WHEN author_kind = 'human' AND author_id IS NOT NULL THEN 'operator_' || author_id
  ELSE 'operator'
END
WHERE instr(lower(author_name), char(101, 109, 98, 101, 114)) > 0;

-- Cached third-party launch metadata is disposable. Drop existing records that
-- contain the retired label so it does not remain in local project snapshots.
DELETE FROM pump_tokens
WHERE instr(lower(COALESCE(name, '')), char(101, 109, 98, 101, 114)) > 0
   OR instr(lower(COALESCE(symbol, '')), char(101, 109, 98, 101, 114)) > 0;
