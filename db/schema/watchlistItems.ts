import { pgTable, uuid, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { searchTerms } from './searchTerms';

/**
 * User-curated lists of specific keywords to watch. See migration 0032 +
 * docs/superpowers/plans/2026-05-28-plan-3.4.2-watchlist.md.
 *
 * Composite PK (user_id, keyword_id) gives uniqueness for free — a
 * double-click on the ⭐ toggle can never create dupes. 100-keyword
 * per-user limit is API-side, not a CHECK constraint.
 */
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id').notNull().references(() => searchTerms.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.keywordId] }),
    userAddedIdx: index('watchlist_items_user_added_idx').on(t.userId, t.addedAt.desc()),
  }),
);

export type WatchlistItemRow = typeof watchlistItems.$inferSelect;
