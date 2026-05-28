-- Hand-picked sets of specific keywords a user wants to track.
--
-- Distinct from saved_views (which are filter rules). A row here =
-- "user X cares about keyword Y, added at time Z".
--
-- 100-keyword limit per user enforced at the API layer (cleaner UX
-- error than a hard CHECK constraint). Composite PK on
-- (user_id, keyword_id) gives uniqueness for free, so a double-click
-- on the ⭐ toggle can't create duplicates.
--
-- See docs/superpowers/plans/2026-05-28-plan-3.4.2-watchlist.md.

CREATE TABLE watchlist_items (
  user_id      uuid        NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  keyword_id   uuid        NOT NULL REFERENCES search_terms(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, keyword_id)
);

-- Watchlist page query: "all keywords this user is watching, newest first"
CREATE INDEX watchlist_items_user_added_idx
  ON watchlist_items (user_id, added_at DESC);
