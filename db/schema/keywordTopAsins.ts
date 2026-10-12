// db/schema/keywordTopAsins.ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, varchar, smallint, numeric, integer, date, boolean, bigint, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Current week's top-3 clicked ASINs per keyword with consecutive-week streaks (spec 2026-10-09
 * §3.2). Rebuilt per import by lib/topAsins/buildWeek.ts; read by the ASIN page and the tools.
 * broad_category (migration 0052): the Brand Analytics code the report filed the clicked product
 * under for this keyword (top_clicked_category_<slot>), null when it gave none; a product belongs to
 * every code it carries (any-of). Indexed over the coded rows for the Products page's broad filter.
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
    /** The report's code for this clicked product (migration 0052); null when it gave none. */
    broadCategory: varchar('broad_category', { length: 255 }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermId, t.slot] }),
    asinIdx: index('keyword_top_asins_asin_idx').on(t.asin, t.searchTermId),
    broadCategoryIdx: index('keyword_top_asins_broad_category_idx').on(t.broadCategory, t.asin).where(sql`${t.broadCategory} IS NOT NULL`),
  }),
);

export const keywordTopAsinsMeta = pgTable('keyword_top_asins_meta', {
  singleton: boolean('singleton').primaryKey().default(true),
  weekEndDate: date('week_end_date'),
  builtAt: timestamp('built_at', { withTimezone: true }),
  rowCount: bigint('row_count', { mode: 'number' }),
});

export type KeywordTopAsinRow = typeof keywordTopAsins.$inferSelect;
