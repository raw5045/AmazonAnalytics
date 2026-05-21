-- Make the volume-estimator calibration time-aware.
--
-- The rank→volume relationship has a non-stationary scale factor —
-- total Amazon search volume swings with season (peak in Nov/Dec,
-- trough in Jan/Feb summer). A single (β, A) pair fit on April data
-- won't accurately represent December volumes.
--
-- Design: each fit is tagged with the month its calibration data came
-- from. Each week W picks the fit with the MAXIMUM calibration month
-- that is ≤ W's month-end (i.e., most-recent-past-or-equal). Future
-- fits never affect past weeks — historical estimates only get
-- "upgraded" when a matching-month fit lands, never replaced
-- retroactively by a later month's fit.
--
-- For weeks before any fit exists (e.g., last year's weeks when we
-- only started calibrating recently), the UI falls back to the
-- earliest available fit with a tooltip flagging the extrapolation.

-- 1. model_calibration_runs gains calibration_month_end_date.
-- Table is currently empty (no fits have been done yet) so we can
-- ADD NOT NULL directly without a backfill.
ALTER TABLE model_calibration_runs
  ADD COLUMN calibration_month_end_date date NOT NULL;

-- Lookup: "which fit applies to week W?" → SELECT ... ORDER BY
-- calibration_month_end_date DESC LIMIT 1 WHERE <= ?
CREATE INDEX model_calibration_runs_cal_month_idx
  ON model_calibration_runs (calibration_month_end_date DESC);

-- 2. poe_calibration_data gains a month dimension on the PK so we can
-- store historical POE snapshots without overwriting each month.
-- The 5,461 rows already in the table were uploaded for April 2026 —
-- backfill them to that month.

ALTER TABLE poe_calibration_data
  ADD COLUMN month_end_date date;

UPDATE poe_calibration_data
  SET month_end_date = '2026-04-30'
  WHERE month_end_date IS NULL;

ALTER TABLE poe_calibration_data
  ALTER COLUMN month_end_date SET NOT NULL;

-- Swap the PK from (search_term_normalized) to the composite key.
ALTER TABLE poe_calibration_data
  DROP CONSTRAINT poe_calibration_data_pkey;

ALTER TABLE poe_calibration_data
  ADD CONSTRAINT poe_calibration_data_pkey
  PRIMARY KEY (search_term_normalized, month_end_date);

-- Lookup: "all POE data for a given month" (used by the fit script
-- to assemble training pairs).
CREATE INDEX poe_calibration_data_month_idx
  ON poe_calibration_data (month_end_date);

COMMENT ON COLUMN model_calibration_runs.calibration_month_end_date IS
  'Month whose POE + BA data was used to fit this model. Combined with '
  'fitted_at as the tiebreaker, this is what pickFitForWeek uses to '
  'select the applicable model for any given week.';

COMMENT ON COLUMN poe_calibration_data.month_end_date IS
  'Month this POE pull represents. Composite PK with search_term_normalized '
  'so historical monthly snapshots coexist instead of overwriting each other.';
