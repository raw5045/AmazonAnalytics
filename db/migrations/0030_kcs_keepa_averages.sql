-- Add precomputed AVG-of-top-3-ASINs aggregates to kcs.
--
-- The range filters (priceMin/Max, reviewsMin/Max) added in 0029
-- proved unintuitive: matching "the top-3 SPAN this range" doesn't
-- map cleanly to how users think about competitive analysis. Users
-- want to filter on other criteria (rank band, leaf category), then
-- sort by "show me the keywords with the cheapest competitors" or
-- "show me the keywords whose top-3 have the most reviews."
--
-- These columns enable that sort. NULL when no top-3 ASINs are
-- enriched; otherwise the average over the 1-3 enriched ASINs
-- (NULL-tolerant via FILTER-on-NULL inside the refresh job).

ALTER TABLE keyword_current_summary
  ADD COLUMN avg_price_cents bigint,
  ADD COLUMN avg_reviews integer;
ALTER TABLE keyword_current_summary_stage
  ADD COLUMN avg_price_cents bigint,
  ADD COLUMN avg_reviews integer;

COMMENT ON COLUMN keyword_current_summary.avg_price_cents IS
  'Mean current_price_cents across the top-3 clicked ASINs at the '
  'current week. NULL-tolerant: averages whatever fraction of the 3 '
  'are enriched. NULL when none are enriched.';
COMMENT ON COLUMN keyword_current_summary.avg_reviews IS
  'Mean review_count across the top-3 clicked ASINs at the current '
  'week. Same NULL semantics as avg_price_cents.';

-- Composite indexes (current_week_end_date, avg_*) so explorer sorts
-- by these columns can use index scans rather than seq-scan + sort.
CREATE INDEX IF NOT EXISTS kcs_avg_price_idx
  ON keyword_current_summary (current_week_end_date, avg_price_cents);
CREATE INDEX IF NOT EXISTS kcs_avg_reviews_idx
  ON keyword_current_summary (current_week_end_date, avg_reviews);
