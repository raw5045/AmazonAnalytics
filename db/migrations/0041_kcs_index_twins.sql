-- 0041: stage twins for the five pre-0034 kcs indexes that never got one.
--
-- The weekly refresh RENAME-swaps keyword_current_summary <-> _stage, and
-- indexes travel with their physical table. Five indexes (avg_price,
-- avg_reviews, est_vol_current, lowest_price, most_reviews) existed on only
-- ONE physical table, so the explorer sorts they serve ("Cheapest/most
-- expensive avg price", "Fewest/most avg reviews") were unindexed on
-- alternating weeks — a full 4.2M-row sort instead of an index scan.
-- Same defect family as 0040 (the 0039 column miss).
--
-- NOTE: written against the 2026-07-05 rotation, where the physical table
-- currently named keyword_current_summary is the one MISSING these five
-- (its counterpart, currently named _stage, carries the kcs_* originals).
-- Applied immediately; IF NOT EXISTS makes re-runs safe within this rotation.

CREATE INDEX IF NOT EXISTS kcs_stage_avg_price_idx
  ON keyword_current_summary (current_week_end_date, avg_price_cents);
CREATE INDEX IF NOT EXISTS kcs_stage_avg_reviews_idx
  ON keyword_current_summary (current_week_end_date, avg_reviews);
CREATE INDEX IF NOT EXISTS kcs_stage_est_vol_idx
  ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_current DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS kcs_stage_lowest_price_idx
  ON keyword_current_summary (current_week_end_date, lowest_price_cents);
CREATE INDEX IF NOT EXISTS kcs_stage_most_reviews_idx
  ON keyword_current_summary (current_week_end_date, most_reviews);
