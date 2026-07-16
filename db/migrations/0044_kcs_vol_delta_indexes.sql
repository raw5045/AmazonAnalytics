-- 0044: partial expression indexes for the volume-delta imp/decline sorts
-- (spec docs/superpowers/specs/2026-07-16-volume-movement-sort-design.md).
--
-- Expression + predicate MUST stay byte-identical (alias stripped) with
-- volumeDeltaExpr / volumeDeltaEligibility in lib/explorer/buildQuery.ts —
-- pinned by the "alias-stripped canonical strings" tests. Partial => entries
-- only for computable deltas, so the ORDER BY needs no NULLS handling and ONE
-- index serves both directions (forward = decline ASC, backward = imp DESC).
--
-- Twins on BOTH physical tables: the weekly refresh RENAME-swaps
-- keyword_current_summary <-> _stage and indexes travel with their physical
-- table — a single-sided index goes missing every other week (see 0041).
-- 1w uses prior_week_rank (kcs has no rank_1w_ago).

CREATE INDEX IF NOT EXISTS kcs_vol_delta_1w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN prior_week_rank IS NULL THEN 0 ELSE estimated_monthly_volume_1w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (prior_week_rank IS NULL OR estimated_monthly_volume_1w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_stage_vol_delta_1w_idx
  ON keyword_current_summary_stage
  (((estimated_monthly_volume_current - CASE WHEN prior_week_rank IS NULL THEN 0 ELSE estimated_monthly_volume_1w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (prior_week_rank IS NULL OR estimated_monthly_volume_1w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_vol_delta_4w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN rank_4w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_4w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_4w_ago IS NULL OR estimated_monthly_volume_4w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_stage_vol_delta_4w_idx
  ON keyword_current_summary_stage
  (((estimated_monthly_volume_current - CASE WHEN rank_4w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_4w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_4w_ago IS NULL OR estimated_monthly_volume_4w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_vol_delta_13w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN rank_13w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_13w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_13w_ago IS NULL OR estimated_monthly_volume_13w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_stage_vol_delta_13w_idx
  ON keyword_current_summary_stage
  (((estimated_monthly_volume_current - CASE WHEN rank_13w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_13w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_13w_ago IS NULL OR estimated_monthly_volume_13w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_vol_delta_26w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN rank_26w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_26w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_26w_ago IS NULL OR estimated_monthly_volume_26w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_stage_vol_delta_26w_idx
  ON keyword_current_summary_stage
  (((estimated_monthly_volume_current - CASE WHEN rank_26w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_26w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_26w_ago IS NULL OR estimated_monthly_volume_26w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_vol_delta_52w_idx
  ON keyword_current_summary
  (((estimated_monthly_volume_current - CASE WHEN rank_52w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_52w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_52w_ago IS NULL OR estimated_monthly_volume_52w_ago IS NOT NULL);

CREATE INDEX IF NOT EXISTS kcs_stage_vol_delta_52w_idx
  ON keyword_current_summary_stage
  (((estimated_monthly_volume_current - CASE WHEN rank_52w_ago IS NULL THEN 0 ELSE estimated_monthly_volume_52w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_52w_ago IS NULL OR estimated_monthly_volume_52w_ago IS NOT NULL);
