import { pgTable, boolean, date, timestamp, uuid, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * One-row metadata for keyword_current_summary (kcs). Holds the
 * current_week_end_date that all kcs rows share, so explorer queries
 * can inject it as a leading-column equality predicate and let the
 * existing composite indexes serve sorted output instead of falling
 * back to seq scan + sort-to-disk.
 *
 * Updated atomically in the refreshSummary stage-and-swap. Kill
 * switch for the new fast path is `TRUNCATE keyword_current_summary_meta;`
 * — runQuery.ts catches an empty result and reverts to today's
 * behavior (no predicate).
 *
 * See migration 0020.
 */
export const keywordCurrentSummaryMeta = pgTable('keyword_current_summary_meta', {
  singleton: boolean('singleton')
    .primaryKey()
    .default(true)
    .notNull(),
  currentWeekEndDate: date('current_week_end_date').notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  /**
   * Per-snapshot identifier so caches can be keyed by version rather
   * than just by week-end-date — important because a same-week replay
   * or hotfix can produce a new kcs snapshot with the same week.
   * Generated fresh in each refreshSummary swap.
   */
  snapshotVersion: uuid('snapshot_version').notNull(),
  /**
   * Total kcs row count matching the default explorer severity filter
   * (NULL/none/warning). Precomputed during refresh so the default
   * landing pagination footer doesn't need to run a live COUNT.
   */
  defaultSeverityTotal: integer('default_severity_total').notNull(),
});

export type KeywordCurrentSummaryMeta = typeof keywordCurrentSummaryMeta.$inferSelect;
