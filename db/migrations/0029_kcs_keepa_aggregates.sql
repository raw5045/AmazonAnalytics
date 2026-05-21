-- Precompute Keepa-derived aggregates on kcs so the explorer can
-- render + filter by them without per-query JOINs to asin_weekly_data.
--
-- For each kcs row, we look up the Keepa-enriched data for the
-- top-3 clicked ASINs (from kwm.top_clicked_product_1/2/3_asin at the
-- current week) and compute:
--
--   - lowest_price_cents  : MIN(current_price_cents) across slots 1-3
--   - highest_price_cents : MAX(current_price_cents) across slots 1-3
--   - least_reviews       : MIN(review_count) across slots 1-3
--   - most_reviews        : MAX(review_count) across slots 1-3
--   - top_clicked_leaf_category : category_leaf for the slot-1 ASIN
--                                 (the most-clicked product's leaf cat)
--
-- NULL values are ignored by MIN/MAX, so a row whose top-3 are only
-- partially enriched still gets sensible aggregates over whatever IS
-- enriched. If all 3 are unenriched, the columns are NULL — the row
-- won't appear when filtering by price/reviews.

ALTER TABLE keyword_current_summary
  ADD COLUMN lowest_price_cents bigint,
  ADD COLUMN highest_price_cents bigint,
  ADD COLUMN least_reviews integer,
  ADD COLUMN most_reviews integer,
  ADD COLUMN top_clicked_leaf_category text;

ALTER TABLE keyword_current_summary_stage
  ADD COLUMN lowest_price_cents bigint,
  ADD COLUMN highest_price_cents bigint,
  ADD COLUMN least_reviews integer,
  ADD COLUMN most_reviews integer,
  ADD COLUMN top_clicked_leaf_category text;

COMMENT ON COLUMN keyword_current_summary.lowest_price_cents IS
  'MIN current_price_cents from Keepa for the top-3 clicked ASINs at '
  'the current week. NULL if all 3 ASINs are unenriched.';

-- Index for leaf-category dropdown lookups (matches the broad-category
-- pattern). Composite with current_week_end_date so the existing
-- predicate-injection pattern in runQuery keeps working.
CREATE INDEX IF NOT EXISTS kcs_leaf_category_idx
  ON keyword_current_summary (current_week_end_date, top_clicked_leaf_category);

-- Indexes for price + review range filters. Each is a composite with
-- current_week_end_date so explorer queries that already inject that
-- predicate (the fast path) can also use these for filtering.
--
-- We index only the "tightest" bound for each axis because most
-- real-world filters look like "show me products with min price >= X"
-- or "max price <= Y" — the index supports both directions of range
-- queries via inclusive/exclusive scans on the second column.
CREATE INDEX IF NOT EXISTS kcs_lowest_price_idx
  ON keyword_current_summary (current_week_end_date, lowest_price_cents);
CREATE INDEX IF NOT EXISTS kcs_most_reviews_idx
  ON keyword_current_summary (current_week_end_date, most_reviews);

-- Parallel facets table for the leaf-category dropdown. Same pattern
-- as keyword_current_summary_category_facets (broad cat) but populated
-- with the new top_clicked_leaf_category values. Populated atomically
-- alongside the kcs stage-and-swap.
CREATE TABLE IF NOT EXISTS keyword_current_summary_leaf_category_facets (
  snapshot_version uuid NOT NULL,
  leaf_category text NOT NULL,
  default_severity_count integer NOT NULL,
  all_count integer NOT NULL,
  PRIMARY KEY (snapshot_version, leaf_category)
);

CREATE INDEX IF NOT EXISTS kcs_leaf_facets_snapshot_idx
  ON keyword_current_summary_leaf_category_facets (snapshot_version);
