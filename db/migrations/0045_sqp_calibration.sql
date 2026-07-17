-- 0045: SQP calibration source (spec docs/superpowers/specs/2026-07-16-sqp-calibration-design.md).
-- Structural mirror of poe_calibration_data; joined to monthly_sfr on
-- (search_term_normalized, month_end_date) to build (rank, volume) pairs.
-- SQP volume = Brand Analytics "Search Query Volume" (marketplace-wide
-- unique-customer query count for the month).

CREATE TABLE IF NOT EXISTS sqp_calibration_data (
  search_term_normalized text NOT NULL,
  month_end_date         date NOT NULL,
  sqp_monthly_volume     bigint NOT NULL,
  source_filename        text,
  imported_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_term_normalized, month_end_date)
);
CREATE INDEX IF NOT EXISTS sqp_calibration_volume_idx ON sqp_calibration_data (sqp_monthly_volume);
CREATE INDEX IF NOT EXISTS sqp_calibration_month_idx  ON sqp_calibration_data (month_end_date);
