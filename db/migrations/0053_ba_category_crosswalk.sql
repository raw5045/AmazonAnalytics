-- db/migrations/0053_ba_category_crosswalk.sql
-- 0053 (hand-numbered, applied by the untracked scripts/applyMigration0053.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-14 (products BA crosswalk) §4.1.
-- ADDITIVE: one small table (Keepa category path → Brand Analytics code, one row per distinct
-- asin_products.category_path, ~24k rows) and its (code, path) index. Empty until the first build
-- (lib/baCategory/buildCrosswalk.ts, run by hand once, then by every weekly import).
-- Must be applied BEFORE the code that reads it deploys: the readers fail loudly (42P01) without it.

CREATE TABLE IF NOT EXISTS ba_category_crosswalk (
  category_path text PRIMARY KEY,
  code varchar(255) NOT NULL,
  source_path text NOT NULL,
  votes integer NOT NULL,
  share_pct smallint NOT NULL,
  week_end_date date NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ba_category_crosswalk_code_idx ON ba_category_crosswalk (code, category_path);
--> statement-breakpoint
COMMENT ON TABLE ba_category_crosswalk IS
  'Keepa category path (as asin_products.category_path) -> Brand Analytics code, one row per path in the catalog; relearned at each weekly import (lib/baCategory/buildCrosswalk.ts). A product''s broad category is the code of its path. source_path = the path whose vote decided it (the path itself, or the ancestor it backed off to); votes = training products there, all codes; share_pct = the winning code''s share of them.';
