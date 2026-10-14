-- db/migrations/0054_drop_top_asins_broad_category.sql
-- 0054 (hand-numbered, applied by the untracked scripts/applyMigration0054.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-14 (products BA crosswalk) §4.2.
-- RETIRES arc 9's per-row code on the keyword→ASIN pair table: the Keepa-path crosswalk
-- (ba_category_crosswalk, 0053) replaced it. DROP COLUMN drops keyword_top_asins_broad_category_idx
-- (and _prev's copy, whatever name a swap left it under) with the column. Metadata only: instant, a
-- brief exclusive lock readers queue behind for milliseconds.
-- Apply only AFTER the deploy that stops reading the column is green: the readers before it select
-- broad_category and would fail with 42703.

ALTER TABLE keyword_top_asins DROP COLUMN IF EXISTS broad_category;
--> statement-breakpoint
ALTER TABLE IF EXISTS keyword_top_asins_prev DROP COLUMN IF EXISTS broad_category;
