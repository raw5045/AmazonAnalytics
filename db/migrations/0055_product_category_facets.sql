-- db/migrations/0055_product_category_facets.sql
-- 0055 (hand-numbered, applied by the untracked scripts/applyMigration0055.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-19 (products list polish) §4.
-- ADDITIVE: one small table (one row per distinct asin_products.category_path among the rows the
-- Products page can show, with its department and product count; ~23k rows) and its
-- (department, path) index. Empty until the first build (lib/products/buildCategoryFacets.ts: once by
-- hand through scripts/buildProductCategoryFacets.ts, then by every weekly import's
-- category_facets_build phase).
-- Must be applied BEFORE the code that reads it deploys: the list readers reject (42P01) without it —
-- the tools surface that error, the page shows empty category lists, as it does while the table is empty.

CREATE TABLE IF NOT EXISTS product_category_facets (
  category_path text PRIMARY KEY,
  department text NOT NULL,
  product_count integer NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_category_facets_department_idx ON product_category_facets (department, category_path);
--> statement-breakpoint
COMMENT ON TABLE product_category_facets IS
  'One row per distinct asin_products.category_path among the in-scope active/no_price rows, with its department (category_root) and product count. Rebuilt in one transaction by every weekly import (lib/products/buildCategoryFacets.ts) and by hand (scripts/buildProductCategoryFacets.ts); the Products page''s and tools'' department and leaf-category lists read it instead of scanning the catalog.';
