-- db/migrations/0051_products.sql
-- 0051 (hand-numbered, applied by the untracked scripts/applyMigration0051.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-09 §3.
-- ADDITIVE: one catalog column, six partial indexes, the keyword→ASIN reverse table and its meta row.
-- Safe to apply before any code that reads these is deployed.

ALTER TABLE asin_products ADD COLUMN IF NOT EXISTS rank_ratio_x100 integer;
COMMENT ON COLUMN asin_products.rank_ratio_x100 IS
  'round(100 * sales_rank / avg30_sales_rank); null unless both > 0. Below 100 = better than its 30-day average. Written by the Keepa service on each successful fetch (null on delisted/error).';

-- Product-search filters (spec §3.1): one partial index per selective column over the rows the
-- Products page can show. Postgres combines them (bitmap AND) for mixed filters.
CREATE INDEX IF NOT EXISTS asin_products_listed_since_idx ON asin_products (listed_since)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_monthly_sold_idx ON asin_products (monthly_sold)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_review_count_idx ON asin_products (review_count)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_sales_rank_idx ON asin_products (sales_rank)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_price_idx ON asin_products (current_price_cents)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_rank_ratio_idx ON asin_products (rank_ratio_x100)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');

-- Reverse table: one row per (keyword, ASIN, slot) in the CURRENT week's top-3 clicked products,
-- with the consecutive-weeks streak (spec §3.2–3.3). Replaced wholesale by each build
-- (lib/topAsins/buildWeek.ts) through a rename swap, so readers never see a half-built week.
CREATE TABLE IF NOT EXISTS keyword_top_asins (
  search_term_id uuid NOT NULL,
  asin text NOT NULL,
  slot smallint NOT NULL CHECK (slot IN (1, 2, 3)),
  click_share numeric(5, 2),
  conversion_share numeric(5, 2),
  weeks_in_top3 integer NOT NULL CHECK (weeks_in_top3 >= 1),
  streak_started_week date NOT NULL,
  week_end_date date NOT NULL,
  PRIMARY KEY (search_term_id, slot)
);
COMMENT ON TABLE keyword_top_asins IS
  'Current week''s top-3 clicked ASINs per keyword with consecutive-week streaks. Rebuilt per import (lib/topAsins/buildWeek.ts); backfilled once by scripts/backfillTopAsins.ts.';
CREATE INDEX IF NOT EXISTS keyword_top_asins_asin_idx ON keyword_top_asins (asin, search_term_id);

CREATE TABLE IF NOT EXISTS keyword_top_asins_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  week_end_date date,
  built_at timestamptz,
  row_count bigint
);
INSERT INTO keyword_top_asins_meta (singleton) VALUES (true) ON CONFLICT DO NOTHING;
