-- POE calibration data: a sample of keywords for which the user pulled
-- Amazon's Product Opportunity Explorer (POE) search volumes. Paired
-- with monthly_sfr on `search_term_normalized` to build (rank, volume)
-- training pairs for the rank→volume model.
--
-- Why poe_30_day_volume is NOT NULL (vs the original plan's
-- poe_360_day_volume):
--   We pivoted to the 30-day BA-vs-POE pair calibration as the primary
--   path during the planning conversation. The user's sample data is
--   30-day. Longer-window columns are optional secondary anchors.

CREATE TABLE poe_calibration_data (
  search_term_normalized   text PRIMARY KEY,
  /** The required 30-day window — paired with monthly_sfr for fitting. */
  poe_30_day_volume        bigint NOT NULL,
  /** Optional secondary windows (used as high-volume anchors if available). */
  poe_60_day_volume        bigint,
  poe_90_day_volume        bigint,
  poe_180_day_volume       bigint,
  poe_360_day_volume       bigint,
  /** Provenance + freshness. */
  source_filename          text,
  imported_at              timestamptz NOT NULL DEFAULT now()
);

-- Sample-size + distribution diagnostic queries hit this index:
--   "what's the volume distribution in our sample?"
CREATE INDEX poe_calibration_volume_idx
  ON poe_calibration_data (poe_30_day_volume);

COMMENT ON TABLE poe_calibration_data IS
  'POE search volumes for a sample of keywords. Paired with '
  'monthly_sfr to build (rank, volume) pairs for fitting the '
  'rank-to-volume model. Currently populated via '
  'scripts/ingestPoeCalibration.ts.';

-- One row per model-fit run. Latest row by fitted_at is the "live"
-- model. History lets us:
--   - Watch β drift across recalibrations
--   - Compare a candidate fit against the production one before swapping
--   - Roll back if a new fit underperforms

CREATE TABLE model_calibration_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fitted_at                timestamptz NOT NULL DEFAULT now(),
  /** Power-law exponent (rank^-β). Expected: 0.4-1.2; data decides. */
  beta                     numeric(6,4) NOT NULL,
  /** Constant A such that estimated_volume = A * rank^-β. */
  scale_factor             numeric(20,6) NOT NULL,
  /** Sample size + train/holdout split. */
  n_training_keywords      integer NOT NULL,
  n_holdout_keywords       integer NOT NULL,
  /** Validation metrics: median absolute % error by rank band on holdout. */
  mape_overall             numeric(5,2),
  mape_top_1k              numeric(5,2),
  mape_1k_10k              numeric(5,2),
  mape_10k_100k            numeric(5,2),
  mape_above_100k          numeric(5,2),
  /** Free-form notes for the analyst (e.g., "after April POE pull"). */
  notes                    text
);

CREATE INDEX model_calibration_runs_latest_idx
  ON model_calibration_runs (fitted_at DESC);

COMMENT ON TABLE model_calibration_runs IS
  'Each row = one fit of the rank-to-volume model. Latest row by '
  'fitted_at is what refreshSummary reads. History lets us compare '
  'candidate fits + roll back if needed.';
