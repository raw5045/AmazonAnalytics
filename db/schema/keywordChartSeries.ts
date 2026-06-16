import { pgTable, uuid, jsonb, date, timestamp } from 'drizzle-orm/pg-core';
import { searchTerms } from './searchTerms';

/** One compact week in keyword_chart_series.series. Short keys keep the row small. */
export interface ChartSeriesEntry {
  w: string;                                              // week_end_date 'YYYY-MM-DD'
  r: number;                                              // actual_rank
  sev: string | null;                                     // fake_volume_severity (raw; masked at render)
  es: string | null;                                      // fake_volume_eval_status
  cs: string | null;                                      // top_clicked_product_1_click_share
  vs: string | null;                                      // top_clicked_product_1_conversion_share
  t: [boolean | null, boolean | null, boolean | null];    // keyword_in_title_1/2/3 (strict)
  tl: [boolean | null, boolean | null, boolean | null];   // keyword_in_title_1/2/3_loose
}

/**
 * Compact per-keyword chart-data store for the detail page.
 *
 * Each row holds one search term's most-recent ≤52 weeks of chart
 * fields as a jsonb array. The detail page reads this single row to
 * render all chart series without scanning keyword_weekly_metrics.
 *
 * Populated/maintained by the backfill script (one-time) and by
 * refreshSummary (appends the newest week each run, drops weeks
 * beyond the 52-week window). See migration 0036.
 */
export const keywordChartSeries = pgTable('keyword_chart_series', {
  searchTermId: uuid('search_term_id').primaryKey().references(() => searchTerms.id, { onDelete: 'cascade' }),
  series: jsonb('series').$type<ChartSeriesEntry[]>().notNull(),
  lastWeek: date('last_week').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type KeywordChartSeriesRow = typeof keywordChartSeries.$inferSelect;
