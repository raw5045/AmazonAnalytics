import { pgTable, uuid, date, varchar, integer, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user daily activity counters for the admin abuse-digest. See
 * migration 0043 + docs/superpowers/specs/2026-07-13-abuse-digest-design.md.
 *
 * `day` is the ET (America/New_York) calendar date (computed app-side by
 * lib/activity/etDay.ts). ON DELETE CASCADE is deliberate — activity
 * counters must never block the Clerk user.deleted webhook cascade
 * (audit_log's RESTRICT FK is the cautionary tale).
 */
export const userActivityDaily = pgTable(
  'user_activity_daily',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    metric: varchar('metric', { length: 64 }).notNull(),
    count: integer('count').notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.day, t.metric] }),
    dayIdx: index('user_activity_daily_day_idx').on(t.day),
  }),
);

export type UserActivityDailyRow = typeof userActivityDaily.$inferSelect;
