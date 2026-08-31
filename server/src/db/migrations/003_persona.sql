-- user-defined agent personalities: intro text, training notes, and the
-- distilled trait scores that bias the strategy at runtime
ALTER TABLE bots ADD COLUMN persona_json TEXT;
