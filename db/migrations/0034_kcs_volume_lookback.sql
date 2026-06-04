-- 0034: estimated-volume lookback columns on keyword_current_summary.
-- Mirrors the rank_Nw_ago horizons; populated by refreshSummary.
-- Both the live table and the stage table (migration 0012) must match.

ALTER TABLE keyword_current_summary
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_4w_ago  bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_13w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_26w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_52w_ago bigint;

ALTER TABLE keyword_current_summary_stage
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_4w_ago  bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_13w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_26w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_52w_ago bigint;

-- Indexes go on BOTH tables. refreshSummary RENAME-swaps live <-> _stage
-- every refresh (old _stage becomes live), so an index must exist on each
-- physical table to reliably back explorer volume sorts/filters every week.
-- Index names are schema-unique, so the _stage copies get a distinct
-- `kcs_stage_*` prefix; coverage (columns) is identical. (NOTE: pre-existing
-- post-0012 indexes — avg_price, avg_reviews, estimated_monthly_volume_current,
-- lowest/highest_price, leaf_category — are on the LIVE table only, so they
-- are intermittently absent after a swap. That asymmetry predates this
-- migration and is tracked as a separate follow-up.)
CREATE INDEX IF NOT EXISTS kcs_est_vol_4w_idx  ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_4w_ago);
CREATE INDEX IF NOT EXISTS kcs_est_vol_13w_idx ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_13w_ago);
CREATE INDEX IF NOT EXISTS kcs_est_vol_26w_idx ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_26w_ago);
CREATE INDEX IF NOT EXISTS kcs_est_vol_52w_idx ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_52w_ago);

CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_4w_idx  ON keyword_current_summary_stage (current_week_end_date, estimated_monthly_volume_4w_ago);
CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_13w_idx ON keyword_current_summary_stage (current_week_end_date, estimated_monthly_volume_13w_ago);
CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_26w_idx ON keyword_current_summary_stage (current_week_end_date, estimated_monthly_volume_26w_ago);
CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_52w_idx ON keyword_current_summary_stage (current_week_end_date, estimated_monthly_volume_52w_ago);
