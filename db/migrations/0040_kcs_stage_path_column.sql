-- 0040: the missing stage-table half of migration 0039.
--
-- 0039 added top_clicked_category_path to keyword_current_summary but NOT to
-- its persistent _stage twin (every prior kcs migration — 0030/0034/0035/0037 —
-- altered both; see 0034's note: the refresh RENAME-swaps live <-> _stage every
-- run, so columns AND index coverage must exist on both tables). The first
-- refresh after 0039 (2026-07-03 import, week 2026-06-27) failed with:
--   column "top_clicked_category_path" of relation "keyword_current_summary_stage" does not exist
--
-- The index twin matters too: without it, the first successful swap would
-- rotate the only path index (kcs_leaf_path_idx) onto the stage table, leaving
-- the live explorer with no index for leaf/custom category filters.

ALTER TABLE keyword_current_summary_stage
  ADD COLUMN IF NOT EXISTS top_clicked_category_path text;

CREATE INDEX IF NOT EXISTS kcs_stage_leaf_path_idx
  ON keyword_current_summary_stage (current_week_end_date, top_clicked_category_path);
