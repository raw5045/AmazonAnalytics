-- db/migrations/0052_top_asins_broad_category.sql
-- 0052 (hand-numbered, applied by the untracked scripts/applyMigration0052.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-12 (products broad category) §3.
-- ADDITIVE: one nullable column on the keyword→ASIN pair table (and on its retained previous build,
-- when present, so the two stay shaped alike), and one partial index over the coded rows.
-- Safe to apply before the code that writes the column deploys: the old build's INSERT lists its
-- eight columns and leaves the ninth null, and its swap carries this index along unrenamed (LIKE names
-- it keyword_top_asins_next_broad_category_asin_idx on the new live table while the canonical name
-- moves to _prev). A week the old code builds has no codes until it is rebuilt (spec §4), and the new
-- swap tolerates the drifted names (ALTER INDEX IF EXISTS plus a _prev rename guard).

ALTER TABLE keyword_top_asins ADD COLUMN IF NOT EXISTS broad_category varchar(255);
--> statement-breakpoint
COMMENT ON COLUMN keyword_top_asins.broad_category IS
  'Brand Analytics code the weekly report files this clicked product under for this keyword (top_clicked_category_<slot> on the kwm row; null when the report gave none). A product belongs to every code it carries across its keywords (any-of).';
--> statement-breakpoint
ALTER TABLE IF EXISTS keyword_top_asins_prev ADD COLUMN IF NOT EXISTS broad_category varchar(255);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS keyword_top_asins_broad_category_idx ON keyword_top_asins (broad_category, asin)
  WHERE broad_category IS NOT NULL;
