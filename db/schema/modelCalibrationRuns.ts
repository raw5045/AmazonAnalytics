import {
  pgTable,
  uuid,
  integer,
  numeric,
  text,
  timestamp,
  date,
  index,
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
    /** Power-law exponent (rank^-β). Expected: 0.4-1.2; data decides. */
    beta: numeric('beta', { precision: 6, scale: 4 }).notNull(),
    /** Constant A in `estimated_volume = A * rank^-β`. */
    scaleFactor: numeric('scale_factor', { precision: 20, scale: 6 }).notNull(),
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
