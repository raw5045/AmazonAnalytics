import { pgTable, text, bigint, timestamp, date, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * POE calibration sample — keywords for which the user has pulled
 * Amazon's Product Opportunity Explorer search volumes.
 *
 * Keyed by (search_term_normalized, month_end_date) so we keep
 * historical monthly snapshots without overwriting. Joined to
 * `monthly_sfr` on (search_term_normalized, month_end_date) to build
 * (rank, volume) calibration pairs.
 *
 * Primary required column: `poe30DayVolume`. Longer-window columns
 * are optional secondary anchors.
 *
 * See `db/migrations/0025_poe_calibration.sql` (initial creation) and
 * `db/migrations/0026_calibration_time_aware.sql` (added month to PK).
 */
export const poeCalibrationData = pgTable(
  'poe_calibration_data',
  {
    searchTermNormalized: text('search_term_normalized').notNull(),
    /** Month this POE pull represents. Combined with search_term to form the PK. */
    monthEndDate: date('month_end_date').notNull(),
    poe30DayVolume: bigint('poe_30_day_volume', { mode: 'number' }).notNull(),
    poe60DayVolume: bigint('poe_60_day_volume', { mode: 'number' }),
    poe90DayVolume: bigint('poe_90_day_volume', { mode: 'number' }),
    poe180DayVolume: bigint('poe_180_day_volume', { mode: 'number' }),
    poe360DayVolume: bigint('poe_360_day_volume', { mode: 'number' }),
    sourceFilename: text('source_filename'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermNormalized, t.monthEndDate] }),
    volumeIdx: index('poe_calibration_volume_idx').on(t.poe30DayVolume),
    monthIdx: index('poe_calibration_data_month_idx').on(t.monthEndDate),
  }),
);

export type PoeCalibrationRow = typeof poeCalibrationData.$inferSelect;
