import {
  pgTable,
  uuid,
  integer,
  numeric,
  text,
  timestamp,
  date,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';

/**
 * One row per fit of the rank-to-volume model. Latest row by `fittedAt`
 * is the production model that `refreshSummary` reads to populate
 * `estimated_*_volume_current` columns on kcs.
 *
 * History lets us:
 *   - Watch β drift across recalibrations
 *   - Compare a candidate fit against production before swapping
 *   - Roll back if a new fit underperforms
 *
 * See `db/migrations/0025_poe_calibration.sql`.
 */
export const modelCalibrationRuns = pgTable(
  'model_calibration_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fittedAt: timestamp('fitted_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Month whose POE + BA data was used to fit this model.
     * Drives `pickFitForWeek` — for each week W, we use the fit with
     * the MAX `calibrationMonthEndDate` that's ≤ W's month-end. Falls
     * back to the earliest fit if none qualify (UI shows "extrapolated"
     * tooltip in that case).
     */
    calibrationMonthEndDate: date('calibration_month_end_date').notNull(),
    /**
     * Power-law exponent (rank^-β) of the first (or only) segment.
     * For piecewise fits, this is the head-segment β; refresh +
     * detail-page predictors read fit_params for the full multi-
     * segment data and only use this column as a fallback. Expected
     * range: 0.3-1.5; data decides.
     */
    beta: numeric('beta', { precision: 6, scale: 4 }).notNull(),
    /**
     * Constant A for the first (or only) segment.
     * For piecewise fits, this is the head-segment A.
     */
    scaleFactor: numeric('scale_factor', { precision: 20, scale: 6 }).notNull(),
    /**
     * Structured fit data — see migration 0028. Supports single and
     * piecewise fits in one column. NULL on legacy rows (they fall
     * back to (beta, scale_factor) as a single segment).
     */
    fitParams: jsonb('fit_params').$type<FitParamsJson | null>(),
    nTrainingKeywords: integer('n_training_keywords').notNull(),
    nHoldoutKeywords: integer('n_holdout_keywords').notNull(),
    /** Validation: median absolute % error on holdout, by rank band. */
    mapeOverall: numeric('mape_overall', { precision: 5, scale: 2 }),
    mapeTop1k: numeric('mape_top_1k', { precision: 5, scale: 2 }),
    mape1k10k: numeric('mape_1k_10k', { precision: 5, scale: 2 }),
    mape10k100k: numeric('mape_10k_100k', { precision: 5, scale: 2 }),
    mapeAbove100k: numeric('mape_above_100k', { precision: 5, scale: 2 }),
    notes: text('notes'),
  },
  (t) => ({
    latestIdx: index('model_calibration_runs_latest_idx').on(t.fittedAt.desc()),
    calMonthIdx: index('model_calibration_runs_cal_month_idx').on(t.calibrationMonthEndDate.desc()),
  }),
);

export type ModelCalibrationRun = typeof modelCalibrationRuns.$inferSelect;

/**
 * Shape of `fit_params` stored in the jsonb column. Mirrors the
 * production `PiecewiseFit` type from lib/analytics/volumeModel.ts
 * but kept inline here so the schema is self-describing.
 */
export interface FitParamsJson {
  kind: 'single' | 'piecewise';
  /** Anchor pair (rank, volume) the head segment passes through, if any. */
  anchor: { rank: number; volume: number } | null;
  /** Breakpoint ranks between segments. Length = segments.length - 1. */
  breakpoints: number[];
  /** Per-segment (β, A). Always at least one entry. */
  segments: Array<{ beta: number; scaleFactor: number }>;
  /** Threshold used for iterative outlier trimming during the fit. */
  trimDropRatio: number | null;
  /** How many calibration pairs were dropped as outliers. */
  nDropped: number;
}
