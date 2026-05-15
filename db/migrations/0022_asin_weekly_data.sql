-- Per-(asin, week) snapshot of Keepa-sourced product data. Aligns
-- with the kwm weekly cadence so the join is direct: a kwm row at
-- (week_end_date, search_term_id) → up to 3 asins → up to 3
-- asin_weekly_data rows at the same week_end_date.
--
-- We enrich at most once per ASIN per week. Two weeks later, the row
-- for that ASIN at the new week exists alongside the old one; the
-- "current" view is simply ORDER BY week_end_date DESC LIMIT 1 per
-- ASIN, and the historical trajectory is just every row.
--
-- Scope: only top-3 ASINs in kwm with actual_rank <= 100000 AND not
-- in the excluded-categories list (see lib/keepa/categoryExclusions.ts).
-- The Inngest job that fills this table enforces the scope; the table
-- itself has no rank/category constraints — keeps it generic in case
-- we widen scope later.
--
-- enrichment_status state machine:
--   'active'    — got price + reviews + rating (the happy path)
--   'no_price'  — Keepa returned the product but no current price
--                 (csv[0] and csv[1] both -1 at last position).
--                 Amazon stopped listing; may come back. Reviews,
--                 rating, image, category usually still present.
--   'delisted'  — Keepa returned no product at all. Fully purged.
--                 Only asin + status + enriched_at populated.
--   'error'     — HTTP/network error or parse failure. error_message
--                 has detail.
--
-- Refresh policy is in the job logic, not the schema:
--   active/no_price → refresh every 7 days
--   delisted        → skip for 30 days, then one re-check
--   error           → retry next weekly cycle
--
-- buy_box_seller_id intentionally NOT a column: capturing it requires
-- Keepa stats=1, which doubles per-ASIN token cost. Excluded per the
-- 2026-05-15 planning conversation.

-- Step 1 — Enum type for the status state machine.
CREATE TYPE asin_enrichment_status AS ENUM (
  'active',
  'no_price',
  'delisted',
  'error'
);

-- Step 2 — The table itself.
CREATE TABLE asin_weekly_data (
  asin                   text NOT NULL,
  week_end_date          date NOT NULL,

  -- Product metadata (from Keepa product object)
  title                  text,
  brand                  text,
  -- Primary product image URL. Keepa returns imagesCSV (comma-separated
  -- image keys); we take the first and prepend the Amazon image CDN
  -- host. May be null for some ASINs. Bytes are not hosted by us —
  -- the URL points at Amazon's CDN directly.
  image_url              text,

  -- Specific category path (from Keepa categoryTree)
  category_path          text,                 -- "Tools › Bath › Faucets"
  category_root          text,                 -- denormalized, for top-level filters
  category_leaf          text,                 -- denormalized, for leaf filters

  -- Time-varying metrics (extracted from Keepa csv arrays)
  current_price_cents    integer,              -- csv[0] last value, fallback csv[1]
  sales_rank             integer,              -- csv[3] last value
  review_count           integer,              -- csv[17] last value
  average_rating_x10     integer,              -- csv[16] last value (0-50, divide by 10)
  last_rating_update     date,                 -- product.lastRatingUpdate, Keepa Minutes → date

  -- Trailing-window averages, computed from csv[0] history at parse time
  avg30_price_cents      integer,
  avg90_price_cents      integer,
  avg180_price_cents     integer,
  avg365_price_cents     integer,

  -- Variations (sibling ASINs) — JSONB array of ASIN strings, e.g. ["B00...","B01..."]
  variations             jsonb,

  -- Promotions JSONB — Keepa's promotions field as-is
  promotions             jsonb,

  -- Enrichment metadata
  enrichment_status      asin_enrichment_status NOT NULL,
  error_message          text,
  enriched_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (asin, week_end_date)
);

-- Step 3 — Indexes.

-- For the explorer cascading filter: "rows in this week filtered by category_root"
CREATE INDEX asin_weekly_data_week_root_idx
  ON asin_weekly_data (week_end_date, category_root);

-- For the explorer cascading filter (Phase 1): "rows in this week filtered by category_leaf"
CREATE INDEX asin_weekly_data_week_leaf_idx
  ON asin_weekly_data (week_end_date, category_leaf);

-- For "look up all weeks of one ASIN" — rank trajectory queries
CREATE INDEX asin_weekly_data_asin_idx
  ON asin_weekly_data (asin);

-- For the 30-day delisted re-check job: "delisted rows enriched > 30 days ago"
-- Partial index keeps it tiny (delisted is rare) and makes the scan fast.
CREATE INDEX asin_weekly_data_delisted_recheck_idx
  ON asin_weekly_data (enriched_at)
  WHERE enrichment_status = 'delisted';

COMMENT ON TABLE asin_weekly_data IS
  'Per-(asin, week) snapshot of Keepa-sourced product data. Latest row '
  'per ASIN = current state; full set per ASIN = weekly trajectory. '
  'Filled by inngest/functions/enrichKeepaForWeek.ts after each kcs refresh.';
