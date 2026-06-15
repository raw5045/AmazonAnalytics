-- 0035_kcs_volume_1w.sql
-- 1-week-ago estimated monthly volume, for Volume-mode Movement jumps at the
-- 1w window. Added to BOTH swap tables so it survives the stage/live rotation.
ALTER TABLE keyword_current_summary       ADD COLUMN IF NOT EXISTS estimated_monthly_volume_1w_ago bigint;
ALTER TABLE keyword_current_summary_stage ADD COLUMN IF NOT EXISTS estimated_monthly_volume_1w_ago bigint;

CREATE INDEX IF NOT EXISTS kcs_est_vol_1w_idx
  ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_1w_ago);
CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_1w_idx
  ON keyword_current_summary_stage (current_week_end_date, estimated_monthly_volume_1w_ago);
