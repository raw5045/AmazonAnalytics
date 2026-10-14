// db/schema/baCategoryCrosswalk.ts
import { pgTable, text, varchar, integer, smallint, date, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Keepa category path → Brand Analytics code (migration 0053; spec 2026-10-14 §4.1): at most one
 * row per distinct asin_products.category_path (none for a path newer than the last build, or whose
 * department has no votes), relearned at each weekly import by lib/baCategory/buildCrosswalk.ts.
 * A product's broad category is the code of its path, joined at read time (nothing is stored on the
 * product). The index serves the search predicate's subquery (one code's paths) and the code list.
 */
export const baCategoryCrosswalk = pgTable(
  'ba_category_crosswalk',
  {
    categoryPath: text('category_path').primaryKey(),
    code: varchar('code', { length: 255 }).notNull(),
    /** The path whose votes decided the code: the path itself, or the ancestor it backed off to. */
    sourcePath: text('source_path').notNull(),
    /** Training products at source_path, all codes. */
    votes: integer('votes').notNull(),
    /** The winning code's share of those votes, 0–100. */
    sharePct: smallint('share_pct').notNull(),
    weekEndDate: date('week_end_date').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: index('ba_category_crosswalk_code_idx').on(t.code, t.categoryPath),
  }),
);

export type BaCategoryCrosswalkRow = typeof baCategoryCrosswalk.$inferSelect;
