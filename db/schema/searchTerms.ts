import { pgTable, uuid, varchar, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const searchTerms = pgTable(
  'search_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    searchTermRaw: varchar('search_term_raw', { length: 512 }).notNull(),
    searchTermNormalized: varchar('search_term_normalized', { length: 512 }).notNull(),
    firstSeenWeek: date('first_seen_week').notNull(),
    lastSeenWeek: date('last_seen_week').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    normalizedIdx: uniqueIndex('search_terms_normalized_idx').on(t.searchTermNormalized),
    // GIN trigram index added manually via SQL in migration (drizzle-kit doesn't emit GIN trgm)
  }),
);

export type SearchTerm = typeof searchTerms.$inferSelect;
export type NewSearchTerm = typeof searchTerms.$inferInsert;
