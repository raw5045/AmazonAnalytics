-- db/migrations/0054_drop_top_asins_broad_category.sql
-- 0054 (hand-numbered, applied by the untracked scripts/applyMigration0054.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-14 (products BA crosswalk) §4.2.
-- RETIRES arc 9's per-row code on the keyword→ASIN pair table: the Keepa-path crosswalk
-- (ba_category_crosswalk, 0053) replaced it. DROP COLUMN drops keyword_top_asins_broad_category_idx
-- with the column: each table's partial index, whatever name a swap left it under (a build of the new
-- code leaves the live copy under the name LIKE gave it). Metadata only: instant on an idle table;
-- behind an in-flight reader or build the lock waits (the apply script gives up after 5 s and retries)
-- and new readers queue behind it meanwhile.
-- Apply only AFTER the deploy is green on web and worker: before it, the readers select
-- broad_category (42703 fails the page) and the old build's INSERT names it (the import's
-- top_asins_build phase fails soft; the pair table stays a week behind). A rollback to the arc-9
-- code after this needs 0052 re-applied first (idempotent).

ALTER TABLE keyword_top_asins DROP COLUMN IF EXISTS broad_category;
--> statement-breakpoint
ALTER TABLE IF EXISTS keyword_top_asins_prev DROP COLUMN IF EXISTS broad_category;
