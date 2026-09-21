import { pgTable, uuid, varchar, timestamp, integer, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-account, per-channel, per-minute usage counters for the research
 * service (amendment §6). One atomic upsert per request reserves the page
 * size in `rows`; the hourly cleanup deletes buckets older than a day.
 * See migration 0047.
 */
export const researchUsageBuckets = pgTable(
  'research_usage_buckets',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 }).notNull(),
    bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
    requests: integer('requests').notNull().default(0),
    rows: integer('rows').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.channel, t.bucketStart] }),
    startIdx: index('research_usage_buckets_start_idx').on(t.bucketStart),
  }),
);
export type ResearchUsageBucketRow = typeof researchUsageBuckets.$inferSelect;
