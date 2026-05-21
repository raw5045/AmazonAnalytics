-- Monthly SFR snapshot from Amazon Brand Analytics.
--
-- Separate from the weekly keyword_weekly_metrics path because:
--   - The file format is the monthly aggregate (different cadence)
--   - Uploaded ad-hoc for the volume-estimator calibration sample,
--     not as the app's regular heartbeat
--   - We only care about (term, month) → rank pairs for calibration;
--     the rich top-clicked-product columns from the BA report are
--     ignored here
--
-- Primary use: paired with poe_calibration_data on (normalized_term)
-- to build empirical (rank, volume) calibration pairs for fitting
-- the rank→volume model.
--
-- One row per (search_term_normalized, month_end_date). Dedup within
-- an upload (multiple raw terms collapsing to one normalized form)
-- uses the same MIN-rank semantics as the weekly path:
--   - Multiple raw rows with the same normalized form → keep the
--     lowest (best) rank
-- For v1 we skip the duplicate-audit log (import_duplicate_search_terms
-- extension) since this ingest is a one-off for calibration; forensic
-- visibility into collapses isn't worth the schema complexity.

CREATE TABLE monthly_sfr (
  search_term_normalized   text NOT NULL,
  month_end_date           date NOT NULL,
  actual_rank              integer NOT NULL,
  source_filename          text,
  imported_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_term_normalized, month_end_date)
);

-- For the calibration JOIN: "all keywords at rank ≤ N for month M"
-- (used during EDA + fitting to filter to manageable rank bands)
CREATE INDEX monthly_sfr_month_rank_idx
  ON monthly_sfr (month_end_date, actual_rank);

COMMENT ON TABLE monthly_sfr IS
  'Monthly SFR snapshots from Amazon Brand Analytics, keyed by '
  '(search_term_normalized, month_end_date). Used as the BA-side input '
  'for the rank-to-volume model calibration. Joined to '
  'poe_calibration_data on search_term_normalized to build training pairs.';
