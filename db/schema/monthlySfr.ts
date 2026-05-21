import { pgTable, text, date, integer, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Monthly SFR snapshot from Amazon Brand Analytics. Separate from
 * keyword_weekly_metrics because:
 *   - Different cadence (monthly aggregate vs weekly)
 *   - Ingested ad-hoc for the volume-estimator calibration (not the
 *     app's recurring heartbeat)
 *   - We only need (term, month, rank) here; the rich top-clicked-
 *     product columns from the BA report aren't useful for calibration
 *
 * Joined to poe_calibration_data on `search_term_normalized` to build
 * (rank, volume) training pairs for the rank→volume model fit.
 *
 * See db/migrations/0024_monthly_sfr.sql.
 */
export const monthlySfr = pgTable(
  'monthly_sfr',
  {
    searchTermNormalized: text('search_term_normalized').notNull(),
    monthEndDate: date('month_end_date').notNull(),
    actualRank: integer('actual_rank').notNull(),
    /** Filename the row was ingested from (provenance). */
    sourceFilename: text('source_filename'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermNormalized, t.monthEndDate] }),
    monthRankIdx: index('monthly_sfr_month_rank_idx').on(t.monthEndDate, t.actualRank),
  }),
);

export type MonthlySfrRow = typeof monthlySfr.$inferSelect;
