// db/schema/keywordTopAsins.ts
import { pgTable, uuid, text, smallint, numeric, integer, date, boolean, bigint, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Current week's top-3 clicked ASINs per keyword with consecutive-week streaks (spec 2026-10-09
 * §3.2). Rebuilt per import by lib/topAsins/buildWeek.ts; read by the ASIN page and the tools.
 */
export const keywordTopAsins = pgTable(
  'keyword_top_asins',
  {
    searchTermId: uuid('search_term_id').notNull(),
    asin: text('asin').notNull(),
    slot: smallint('slot').notNull(),
    clickShare: numeric('click_share', { precision: 5, scale: 2 }),
    conversionShare: numeric('conversion_share', { precision: 5, scale: 2 }),
    /** Consecutive built weeks (ending now) the ASIN has been in this keyword's top 3, any slot. */
    weeksInTop3: integer('weeks_in_top3').notNull(),
    streakStartedWeek: date('streak_started_week').notNull(),
    weekEndDate: date('week_end_date').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermId, t.slot] }),
    asinIdx: index('keyword_top_asins_asin_idx').on(t.asin, t.searchTermId),
  }),
);

export const keywordTopAsinsMeta = pgTable('keyword_top_asins_meta', {
  singleton: boolean('singleton').primaryKey().default(true),
  weekEndDate: date('week_end_date'),
  builtAt: timestamp('built_at', { withTimezone: true }),
  rowCount: bigint('row_count', { mode: 'number' }),
});

export type KeywordTopAsinRow = typeof keywordTopAsins.$inferSelect;
