-- 0046: category covering index + stored word_count
-- (spec docs/superpowers/specs/2026-08-23-category-covering-index-design.md)
--
-- word_count: words in search_term_normalized (spaces+1; single-spaced by
-- normalizeForMatch). NULL until the backfill (scripts/backfillWordCount.ts)
-- / the next weekly refresh populates it. The explorer word filter flips to
-- this column ONLY after the backfill verifies zero NULLs.
--
-- Covering index: makes category-scoped filtered queries index-only in
-- their filtering phase. Keys (week, path, rank) put each path's entries
-- rank-adjacent; INCLUDEs cover the always-on severity predicate, the
-- reviews/word range filters, and the id the outer query joins on.
-- Twin-table pattern (see 0044): the weekly refresh RENAME-swaps
-- keyword_current_summary <-> _stage, so BOTH need the index. The live
-- CREATE is CONCURRENTLY (no reader/writer block); _stage sits idle
-- between refreshes so a plain CREATE is fine.
--
-- NOTE for the apply script: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction — statements below are applied one at a time, NOT wrapped.

ALTER TABLE keyword_current_summary ADD COLUMN IF NOT EXISTS word_count smallint;
ALTER TABLE keyword_current_summary_stage ADD COLUMN IF NOT EXISTS word_count smallint;

CREATE INDEX CONCURRENTLY IF NOT EXISTS kcs_cat_cover_idx
  ON keyword_current_summary (current_week_end_date, top_clicked_category_path, current_rank)
  INCLUDE (fake_volume_severity_current, avg_reviews, word_count, search_term_id);

CREATE INDEX IF NOT EXISTS kcs_stage_cat_cover_idx
  ON keyword_current_summary_stage (current_week_end_date, top_clicked_category_path, current_rank)
  INCLUDE (fake_volume_severity_current, avg_reviews, word_count, search_term_id);
