import {
  pgTable,
  uuid,
  text,
  date,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * One row per Keepa enrichment attempt for a given week.
 *
 * Lifecycle (driven by `worker/keepaJobs.ts`):
 *   1. Inngest orchestrator INSERTs a row with status='running'.
 *   2. Worker process starts the detached enrichment Promise; updates
 *      total_asins after listScope, heartbeat_at every 60s, and the
 *      *_count fields as batches land.
 *   3. On success: status='completed', completed_at=now().
 *   4. On error: status='failed', error_message set.
 *   5. If the worker dies silently: heartbeat_at goes stale; the
 *      orchestrator detects this and marks status='orphaned'.
 *
 * Concurrency safety: a partial unique index on (week_end_date)
 * WHERE status='running' enforces at-most-one-active-run-per-week
 * at the DB level — independent of any application-level mutex.
 *
 * See db/migrations/0023_keepa_enrichment_runs.sql for canonical docs.
 */
export const keepaEnrichmentRuns = pgTable(
  'keepa_enrichment_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    weekEndDate: date('week_end_date').notNull(),
    /** One of: 'running' | 'completed' | 'failed' | 'orphaned'. */
    status: text('status').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /** BOOT_ID of the worker process that started this run. */
    ownerBootId: text('owner_boot_id'),

    totalAsins: integer('total_asins'),
    processedAsins: integer('processed_asins').notNull().default(0),
    activeCount: integer('active_count').notNull().default(0),
    noPriceCount: integer('no_price_count').notNull().default(0),
    delistedCount: integer('delisted_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),

    errorMessage: text('error_message'),
  },
  (t) => ({
    weekStartedIdx: index('keepa_runs_week_started_idx').on(t.weekEndDate, t.startedAt.desc()),
    // Partial unique index enforced in the migration SQL — drizzle's
    // uniqueIndex().where() emits inconsistently, so we keep this here
    // as a regular index for type-checking purposes and trust the
    // migration for the partial predicate.
    oneActivePerWeekIdx: uniqueIndex('keepa_runs_one_active_per_week_idx').on(t.weekEndDate),
    statusHeartbeatIdx: index('keepa_runs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
  }),
);

export type KeepaEnrichmentRun = typeof keepaEnrichmentRuns.$inferSelect;
export type KeepaEnrichmentRunStatus = 'running' | 'completed' | 'failed' | 'orphaned';

/** Suppress unused-import warning in case sql template is used elsewhere later. */
void sql;
