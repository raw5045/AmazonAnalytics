import { pgTable, text, bigint, timestamp, date, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * SQP calibration sample — the owner's Brand Analytics Search Query
 * Performance monthly export. "Search Query Volume" is Amazon's
 * marketplace-wide unique-customer query count for the month (not
 * brand-scoped), which makes it the first-party truth source for the
 * rank→volume fit (spec 2026-07-16).
 *
 * Keyed by (search_term_normalized, month_end_date), joined to
 * `monthly_sfr` exactly like poe_calibration_data. POE remains stored
 * for validation + head-supplement pairs; SQP trains.
 *
 * See db/migrations/0045_sqp_calibration.sql.
 */
export const sqpCalibrationData = pgTable(
  'sqp_calibration_data',
  {
    searchTermNormalized: text('search_term_normalized').notNull(),
    /** Month this SQP export represents. Combined with search_term to form the PK. */
    monthEndDate: date('month_end_date').notNull(),
    sqpMonthlyVolume: bigint('sqp_monthly_volume', { mode: 'number' }).notNull(),
    sourceFilename: text('source_filename'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermNormalized, t.monthEndDate] }),
    volumeIdx: index('sqp_calibration_volume_idx').on(t.sqpMonthlyVolume),
    monthIdx: index('sqp_calibration_month_idx').on(t.monthEndDate),
  }),
);

export type SqpCalibrationRow = typeof sqpCalibrationData.$inferSelect;
