-- db/migrations/0056_keyword_counts_and_slow_queries.sql
-- 0056 (hand-numbered, applied by the untracked scripts/applyMigration0056.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-23 (products open-up) §5 and §5b.
-- ADDITIVE. (1) asin_products.keyword_count: the current week's count of keywords the product is a
-- top-3 clicked product for, written weekly by the import's keyword_counts_build phase (and once by hand,
-- scripts/buildKeywordCounts.ts); 0 until then. ADD COLUMN ... DEFAULT 0 is instant (catalog default);
-- the index build takes a brief write lock on asin_products (the Keepa service's batch writes wait).
-- (2) slow_queries: one row per product search that timed out (57014) or ran slower than
-- SLOW_PRODUCT_SEARCH_MS, read by the daily usage digest; pruned to 90 days by the digest job.
-- Apply BEFORE the code deploys: the keywords sort reads the column (42703 without it).

ALTER TABLE asin_products ADD COLUMN IF NOT EXISTS keyword_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_keyword_count_idx ON asin_products (keyword_count, asin);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS slow_queries (
  id bigserial PRIMARY KEY,
  surface text NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NULL,
  query_string text NOT NULL,
  elapsed_ms integer NOT NULL,
  timed_out boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS slow_queries_surface_happened_at_idx ON slow_queries (surface, happened_at);
