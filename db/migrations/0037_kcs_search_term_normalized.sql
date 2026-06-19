-- 0037_kcs_search_term_normalized
-- Denormalize the normalized keyword text onto keyword_current_summary (and
-- its _stage twin) so the explorer "search term contains" filter — whole-word
-- (regex `~ '\m…\M'`) and broad (`LIKE '%…%'`) — runs single-table on the
-- active set (~3.85M rows) via a GIN trigram index, instead of joining/probing
-- all-time search_terms (~9.3M rows). Nullable; populated by
-- scripts/backfillKcsNormalized.ts (live table) and the weekly refresh (stage
-- table). The GIN index is built one-shot AFTER the column is populated (NOT
-- here) to avoid slow incremental GIN maintenance during the bulk refresh
-- INSERT — see explorer-filter-perf spec v2 + refreshSummary / the backfill.
ALTER TABLE "keyword_current_summary" ADD COLUMN IF NOT EXISTS "search_term_normalized" varchar(512);--> statement-breakpoint
ALTER TABLE "keyword_current_summary_stage" ADD COLUMN IF NOT EXISTS "search_term_normalized" varchar(512);
