import { pgTable, uuid, varchar, timestamp, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['admin', 'standard_user']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 255 }),
    role: userRoleEnum('role').notNull().default('standard_user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => ({
    clerkUserIdIdx: uniqueIndex('users_clerk_user_id_idx').on(t.clerkUserId),
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
