// db/schema/weeklyDigest.ts
import { pgTable, uuid, date, text, integer, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Weekly digest send tracking. See migration 0033 +
 * docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md.
 *
 * weekly_digest_runs: one row per week sent; PK on week_end_date is the
 * idempotency gate. weekly_digest_sends: one row per (week, user) — the
 * grain at which sends are idempotent + retryable.
 */
export const weeklyDigestRuns = pgTable('weekly_digest_runs', {
  weekEndDate: date('week_end_date').primaryKey(),
  // 'sending' | 'sent' | 'sent_with_failures' | 'failed'
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  recipientsCount: integer('recipients_count').notNull().default(0),
  sentCount: integer('sent_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
});

export const weeklyDigestSends = pgTable(
  'weekly_digest_sends',
  {
    weekEndDate: date('week_end_date')
      .notNull()
      .references(() => weeklyDigestRuns.weekEndDate, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),       // 'watchlist' | 'broadcast'
    status: text('status').notNull(),          // 'pending' | 'sent' | 'failed'
    resendId: text('resend_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekEndDate, t.userId] }),
    failedIdx: index('weekly_digest_sends_failed_idx').on(t.weekEndDate),
  }),
);

export type WeeklyDigestRunRow = typeof weeklyDigestRuns.$inferSelect;
export type WeeklyDigestSendRow = typeof weeklyDigestSends.$inferSelect;
