import { pgTable, text, bigint, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * POE calibration sample — keywords for which the user has pulled
 * Amazon's Product Opportunity Explorer search volumes. Used as the
 * volume side of the rank-to-volume model fit.
 *
 * Joined to `monthly_sfr` on `search_term_normalized` to build
 * (rank, volume) pairs.
 *
 * Primary required column: `poe_30_day_volume` (matches the user's
 * 30-day BA + 30-day POE pair-calibration architecture). Longer-window
 * columns are optional secondary anchors.
 *
 * See `db/migrations/0025_poe_calibration.sql`.
 */
export const poeCalibrationData = pgTable(
  'poe_calibration_data',
  {
    searchTermNormalized: text('search_term_normalized').primaryKey(),
    poe30DayVolume: bigint('poe_30_day_volume', { mode: 'number' }).notNull(),
    poe60DayVolume: bigint('poe_60_day_volume', { mode: 'number' }),
    poe90DayVolume: bigint('poe_90_day_volume', { mode: 'number' }),
    poe180DayVolume: bigint('poe_180_day_volume', { mode: 'number' }),
    poe360DayVolume: bigint('poe_360_day_volume', { mode: 'number' }),
    sourceFilename: text('source_filename'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    volumeIdx: index('poe_calibration_volume_idx').on(t.poe30DayVolume),
  }),
);

export type PoeCalibrationRow = typeof poeCalibrationData.$inferSelect;
