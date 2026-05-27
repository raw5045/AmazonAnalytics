import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * User-saved bundles of explorer filters. See migration 0031 +
 * docs/superpowers/plans/2026-05-27-plan-3.4.1-saved-views.md.
 *
 * Per-user limit of 5 views is enforced at the API layer, not the DB
 * (cleaner UX error message). Per-user name uniqueness is a DB-level
 * unique index — two users can each have a 'My beauty niche' view,
 * but the same user can't have two views with that name.
 *
 * The `filters` column is the serialized ExplorerFilters object minus
 * pagination. parseExplorerFilters provides defaults for any missing
 * fields, so adding a new filter type in code won't break legacy rows.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    filters: jsonb('filters').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('saved_views_user_id_idx').on(t.userId, t.createdAt.desc()),
    userNameUniq: uniqueIndex('saved_views_user_name_uniq').on(t.userId, t.name),
  }),
);

export type SavedViewRow = typeof savedViews.$inferSelect;
