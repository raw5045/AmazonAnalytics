-- Add covering index `(week_end_date, search_term_id) INCLUDE (actual_rank)`
-- to each yearly partition of keyword_weekly_metrics. This converts the
-- rank-history lookups in refreshKeywordCurrentSummary from Index Scan +
-- heap fetch to Index Only Scan, dropping refresh time from ~155 min to
-- ~29 min (5.3× speedup) on the production dataset.
--
-- This migration is idempotent (CREATE INDEX IF NOT EXISTS). On prod the
-- indexes were originally created CONCURRENTLY by
-- scripts/addRankCoveringIndex.ts, so this migration is a no-op there.
-- On a fresh DB clone or a new test environment, this migration creates
-- the indexes from scratch — non-concurrent, but partitions are typically
-- empty in those scenarios so there's nothing to block.
--
-- For new yearly partitions added in the future (e.g. 2028), update the
-- partition-creation migration to also add the matching covering index,
-- or re-run scripts/addRankCoveringIndex.ts which auto-discovers child
-- partitions and creates the missing index on each.

CREATE INDEX IF NOT EXISTS "kwm_2024_week_term_rank_cover_idx"
  ON "keyword_weekly_metrics_2024" ("week_end_date", "search_term_id")
  INCLUDE ("actual_rank");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kwm_2025_week_term_rank_cover_idx"
  ON "keyword_weekly_metrics_2025" ("week_end_date", "search_term_id")
  INCLUDE ("actual_rank");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kwm_2026_week_term_rank_cover_idx"
  ON "keyword_weekly_metrics_2026" ("week_end_date", "search_term_id")
  INCLUDE ("actual_rank");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kwm_2027_week_term_rank_cover_idx"
  ON "keyword_weekly_metrics_2027" ("week_end_date", "search_term_id")
  INCLUDE ("actual_rank");
