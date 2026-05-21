-- Add piecewise-fit storage to model_calibration_runs.
--
-- Background: a single (β, A) power-law fit produces ~50-77% MAPE on
-- the head ranks because Amazon's rank → volume curve isn't a clean
-- single-exponent power law. Different rank regions have different
-- decay rates (e.g., top-1k volumes don't drop as fast as the deep
-- tail). A 4-segment piecewise fit, anchored to the lowest-SFR pair
-- with iterative outlier trimming, gets Top-1k MAPE from 77% to 37%
-- and median MAPE from 51% to 37%.
--
-- Schema design:
--   - fit_params jsonb: full structured fit, supporting both
--     single-segment (legacy) and piecewise. Shape:
--       {
--         "kind": "piecewise" | "single",
--         "anchor": { "rank": 5, "volume": 3459791 } | null,
--         "breakpoints": [1000, 10000, 100000],
--         "segments": [
--           { "beta": 0.40, "scaleFactor": 6586245 },
--           { "beta": 0.625, "scaleFactor": 31162900 },
--           { "beta": 0.875, "scaleFactor": 311629000 },
--           { "beta": 0.95, "scaleFactor": 738988817 }
--         ],
--         "trimDropRatio": 10,
--         "nDropped": 22
--       }
--   - Legacy beta + scale_factor columns kept as a backstop for
--     single-segment fits. New piecewise fits ALSO populate them with
--     the first-segment values so any code that only reads the
--     legacy columns degrades gracefully (won't blow up, will just
--     use the head-segment fit for everything).

ALTER TABLE model_calibration_runs
  ADD COLUMN fit_params jsonb;

COMMENT ON COLUMN model_calibration_runs.fit_params IS
  'Structured fit parameters. Supports single-segment (kind=single) '
  'and piecewise (kind=piecewise) fits. NULL on legacy rows — those '
  'fall back to (beta, scale_factor) treated as a single segment.';
