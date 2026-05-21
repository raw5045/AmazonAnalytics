-- Add precomputed estimated monthly volume to keyword_current_summary.
--
-- We store the volume estimate on kcs (rather than computing at
-- explorer read-time) for one reason: the explorer page renders 100
-- rows per request, must support sorting + filtering, and must stay
-- fast (~sub-second). Math.pow per row at render time is fine for the
-- detail page (52 rows) but not for sorting a 4M-row table by an
-- expression. Precomputing also makes the value a real columnar
-- citizen — addressable in WHERE clauses, joinable, exportable —
-- without any explorer-side awareness of the rank→volume model.
--
-- The value is computed during refreshKeywordCurrentSummary using
-- the fit selected by pickFitForWeek(current_week_end_date, fits).
-- For weeks before the earliest fit, the earliest fit is used
-- (extrapolated) — this matches the design decision documented in
-- migration 0026's pickFitForWeek semantics.
--
-- Detail page (per-week history) still computes at render time so
-- each historical week can use its own appropriate fit. The kcs
-- column only covers the CURRENT week.

-- 1. Column on both the live table and the stage parallel table.
--    (Required because the refresh's stage-and-swap pattern relies on
--    structural equivalence — see migration 0012.)
ALTER TABLE keyword_current_summary
  ADD COLUMN estimated_monthly_volume_current bigint;
ALTER TABLE keyword_current_summary_stage
  ADD COLUMN estimated_monthly_volume_current bigint;

COMMENT ON COLUMN keyword_current_summary.estimated_monthly_volume_current IS
  'Estimated monthly Amazon search volume for the current week, '
  'computed at refresh time as A * power(current_rank, -beta) using '
  'the fit selected by pickFitForWeek. NULL when no calibration fit '
  'exists at all (cold start).';

-- 2. Index for sort-by-volume-desc paths. Composite on
--    (current_week_end_date, est_vol DESC) so the existing
--    current_week_end_date predicate keeps the index usable.
--
--    Note: a sort by est_vol DESC is mathematically equivalent to a
--    sort by current_rank ASC within a single snapshot (same A, same
--    β for all rows). So the index is more about future-proofing /
--    filtering (e.g., "WHERE est_vol > 1M") than about a distinct
--    sort key — the explorer UI doesn't add a new sort option.
CREATE INDEX IF NOT EXISTS kcs_est_vol_idx
  ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_current DESC NULLS LAST);

-- 3. Track which fit produced the current snapshot's volumes.
--    Lets the explorer render a single page-level chip like
--    "Volumes from April 2026 fit" — and an "extrapolated" warning
--    when the current week predates all fits.
ALTER TABLE keyword_current_summary_meta
  ADD COLUMN volume_fit_run_id uuid REFERENCES model_calibration_runs(id);
ALTER TABLE keyword_current_summary_meta
  ADD COLUMN volume_fit_is_extrapolated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN keyword_current_summary_meta.volume_fit_run_id IS
  'The model_calibration_runs row whose (beta, scale_factor) produced '
  'every estimated_monthly_volume_current value in the current kcs '
  'snapshot. NULL when no fit existed at refresh time.';
COMMENT ON COLUMN keyword_current_summary_meta.volume_fit_is_extrapolated IS
  'True when the chosen fit''s calibration month is AFTER the current '
  'week''s month (i.e., we fell back to the earliest fit because no '
  'past-or-equal fit qualifies). Triggers an "extrapolated" tooltip '
  'in the explorer.';

-- 4. Backfill the existing live kcs from the latest qualifying fit
--    (or, if no qualifying fit exists, the earliest fit with
--    extrapolation). Mirrors pickFitForWeek's logic in pure SQL.
--    Skipped silently when zero fits or zero kcs rows exist.
--
--    This one-time backfill avoids leaving the explorer with all-NULL
--    volumes until the next weekly import triggers a full refresh
--    (which is the path that would otherwise populate the column).
DO $$
DECLARE
  cw date;
  chosen_id uuid;
  chosen_beta numeric;
  chosen_a numeric;
  chosen_is_extrap boolean;
BEGIN
  -- Bail if no meta row (cold app — nothing to update).
  SELECT current_week_end_date INTO cw
    FROM keyword_current_summary_meta WHERE singleton = true;
  IF cw IS NULL THEN
    RAISE NOTICE 'Skipping backfill: no kcs meta row';
    RETURN;
  END IF;

  -- Try latest qualifying-past fit first
  -- (calibration_month_end_date <= end of cw's month).
  SELECT id, beta, scale_factor, false
    INTO chosen_id, chosen_beta, chosen_a, chosen_is_extrap
    FROM model_calibration_runs
    WHERE calibration_month_end_date
      <= (date_trunc('month', cw + interval '1 month') - interval '1 day')::date
    ORDER BY calibration_month_end_date DESC, fitted_at DESC
    LIMIT 1;

  -- Fall back to earliest fit (extrapolation).
  IF chosen_id IS NULL THEN
    SELECT id, beta, scale_factor, true
      INTO chosen_id, chosen_beta, chosen_a, chosen_is_extrap
      FROM model_calibration_runs
      ORDER BY calibration_month_end_date ASC, fitted_at ASC
      LIMIT 1;
  END IF;

  -- If still nothing, no fits at all — leave columns NULL.
  IF chosen_id IS NULL THEN
    RAISE NOTICE 'Skipping backfill: no model_calibration_runs rows';
    RETURN;
  END IF;

  -- Update kcs.
  UPDATE keyword_current_summary kcs
    SET estimated_monthly_volume_current
      = (chosen_a * power(kcs.current_rank::numeric, -chosen_beta))::bigint;

  -- Update meta to reflect the chosen fit.
  UPDATE keyword_current_summary_meta
    SET volume_fit_run_id = chosen_id,
        volume_fit_is_extrapolated = chosen_is_extrap
    WHERE singleton = true;

  RAISE NOTICE 'Backfilled kcs with fit % (extrap=%)', chosen_id, chosen_is_extrap;
END $$;
