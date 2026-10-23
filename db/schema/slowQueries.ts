// db/schema/slowQueries.ts
import { pgTable, bigserial, text, timestamp, uuid, integer, boolean, index } from 'drizzle-orm/pg-core';

/**
 * Slow or timed-out searches (migration 0056; spec 2026-10-23 §5b): one row per product search that hit the
 * 30 s cap (timed_out) or ran slower than SLOW_PRODUCT_SEARCH_MS, with the filter combination as the URL
 * query string, so the daily usage digest can list what runs long and the integration harness can replay it.
 * `surface` is 'products' today; the Keywords tab can join later. Written by lib/products/slowQueries.ts,
 * read by lib/notifications/abuseDigest/loadAbuseDigestData.ts, pruned by the digest job. Type mirror only.
 */
export const slowQueries = pgTable(
  'slow_queries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    surface: text('surface').notNull(),
    happenedAt: timestamp('happened_at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id'),
    queryString: text('query_string').notNull(),
    elapsedMs: integer('elapsed_ms').notNull(),
    timedOut: boolean('timed_out').notNull(),
  },
  (t) => ({
    surfaceHappenedAtIdx: index('slow_queries_surface_happened_at_idx').on(t.surface, t.happenedAt),
  }),
);
export type SlowQueryRow = typeof slowQueries.$inferSelect;
