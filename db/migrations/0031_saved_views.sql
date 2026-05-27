-- User-saved bundles of explorer filters.
--
-- Each row = "this user named this filter set 'X'". Applying a view
-- loads its filters onto /explorer; the URL becomes /explorer?view=<id>
-- + any user overrides as URL params on top.
--
-- 5-view limit per user is enforced at the API layer (cleaner error
-- message than a hard CHECK constraint). Per-user uniqueness on name
-- keeps the dropdown unambiguous and supports name-conflict detection
-- on save.
--
-- See docs/superpowers/plans/2026-05-27-plan-3.4.1-saved-views.md.

CREATE TABLE saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  filters     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Dropdown query: "all my views, newest first"
CREATE INDEX saved_views_user_id_idx ON saved_views (user_id, created_at DESC);

-- Per-user uniqueness on name. Two users CAN have a view named 'X';
-- the same user cannot.
CREATE UNIQUE INDEX saved_views_user_name_uniq ON saved_views (user_id, name);

COMMENT ON COLUMN saved_views.filters IS
  'Serialized ExplorerFilters object minus pagination (page, perPage '
  'are reset to defaults on apply). Schema-flexible — new filter '
  'types added in code get defaults from parseFilters for legacy rows.';
