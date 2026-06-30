-- 0039: path-aware category matching.
-- Add full-path column on the keyword side; switch the facet + custom-category
-- storage from bare leaf NAME to full category PATH. Wipe legacy bare-name
-- custom categories (cannot be auto-disambiguated; user re-creates them).

ALTER TABLE keyword_current_summary ADD COLUMN IF NOT EXISTS top_clicked_category_path text;

CREATE INDEX IF NOT EXISTS kcs_leaf_path_idx
  ON keyword_current_summary (current_week_end_date, top_clicked_category_path);
DROP INDEX IF EXISTS kcs_leaf_category_idx;

ALTER TABLE keyword_current_summary_leaf_category_facets
  RENAME COLUMN leaf_category TO category_path;

ALTER TABLE custom_categories RENAME COLUMN leaf_names TO leaf_paths;
DELETE FROM custom_categories;  -- wipe legacy bare-name rows (3 rows, one user)
