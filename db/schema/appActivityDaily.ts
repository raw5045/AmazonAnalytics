import { pgTable, date, varchar, integer, primaryKey } from 'drizzle-orm/pg-core';

/**
 * App-wide (no-user) daily activity counters — signed-out surfaces like the
 * public contact form. See migration 0043 + the abuse-digest spec.
 */
export const appActivityDaily = pgTable(
  'app_activity_daily',
  {
    day: date('day').notNull(),
    metric: varchar('metric', { length: 64 }).notNull(),
    count: integer('count').notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.metric] }),
  }),
);

export type AppActivityDailyRow = typeof appActivityDaily.$inferSelect;
