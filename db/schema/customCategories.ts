import { pgTable, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Per-user named sets of Keepa leaf-category names, built in the Category
 * Builder tab and reused as an Explorer filter. See migration 0038 +
 * docs/superpowers/specs/2026-06-23-category-builder-design.md.
 *
 * 25-per-user limit is enforced at the API layer. Name uniqueness (per user,
 * case-insensitive) is a DB unique index. `leaf_names` is a deduped string[]
 * of leaf-category names that drops straight into the existing
 * top_clicked_leaf_category IN (...) filter.
 */
export const customCategories = pgTable(
  'custom_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    leafNames: jsonb('leaf_names').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('custom_categories_user_created_idx').on(t.userId, t.createdAt.desc()),
    userNameUniq: uniqueIndex('custom_categories_user_name_uniq').on(t.userId, sql`lower(${t.name})`),
  }),
);

export type CustomCategoryRow = typeof customCategories.$inferSelect;
