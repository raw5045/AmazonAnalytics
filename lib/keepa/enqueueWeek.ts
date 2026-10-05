// lib/keepa/enqueueWeek.ts
/**
 * Enqueue a week's top-3 ASINs for the Keepa service (spec 2026-10-05 §6.1).
 *
 * One upsert over the week's kwm partition: every well-formed top-3 ASIN of the week (same
 * category exclusions as the old enrichment) gets its best keyword rank, the scope week, its
 * tier (1 = rank ≤ TIER1_MAX_RANK, weekly; 2 = the rest) and in_scope = true. Brand-new ASINs
 * start never-fetched and due now. An ASIN moving from tier 2 to tier 1 that was fetched before
 * is pulled forward to a weekly due date. Then every row not seen this week is flagged out of
 * scope — kept, never deleted — and the table is vacuumed (the upsert rewrites every in-scope
 * row, the same churn pattern behind the explorer's old cold loads).
 *
 * Concurrency: the upsert holds row locks on ~2.3M rows for minutes while the Keepa service
 * writes batches of 100 in claim order, so the two would deadlock. The runner holds the
 * exclusive transaction-scoped advisory lock ENQUEUE_LOCK_KEY (`pg_advisory_xact_lock`) across
 * the scope check, the upsert and the retire, in one transaction — transaction-scoped because
 * Neon's pooler (PgBouncer, transaction mode) does not keep session-level locks; the service's
 * store transactions take the shared form first (services/keepa/pgStore.ts) and simply wait.
 * VACUUM runs after COMMIT.
 *
 * Guards: a week that upserts zero rows (not imported yet, or a mistyped date) stops before the
 * retire, and a week older than the catalog's current scope week is refused unless `force` is
 * set — either would otherwise empty or rewind the queue, silently (an empty queue idles with a
 * fresh heartbeat, so no watcher alarm would fire).
 *
 * `client` must be ONE dedicated connection (a pg PoolClient or Client — never a Pool, never
 * already inside a transaction): the runner opens its own transaction, and VACUUM cannot run
 * inside one.
 * Callers: the import's completion step (inngest/functions/importFile.ts, Task 10), the one-time
 * 0050 seed (untracked scripts/applyMigration0050.ts), and scripts/fireEnqueueWeek.ts (Task 10).
 */
import { EXCLUDED_CATEGORIES_ARRAY } from './categoryExclusions';
import { ENQUEUE_LOCK_KEY, TIER1_MAX_RANK, TIER1_REFRESH_DAYS } from './lanes';

export interface SqlStatement {
  text: string;
  values: unknown[];
}
export interface EnqueueWeekStatements {
  upsert: SqlStatement;
  retire: SqlStatement;
}
/** The slice of pg's PoolClient/Client the runner needs — keeps the unit test free of a database. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
}
export interface EnqueueWeekResult {
  inserted: number;
  updated: number;
  retired: number;
  vacuumed: boolean;
}
export interface EnqueueWeekOptions {
  /** Enqueue a week older than the catalog's scope week anyway (never from the import hook). */
  force?: boolean;
  /** Skip the VACUUM (ANALYZE) after the retire. */
  vacuum?: boolean;
}

export type EnqueueWeekErrorCode = 'enqueue_week_bad_date' | 'enqueue_week_no_rows' | 'enqueue_week_older_than_scope';

/** Carries a `code` so the import hook's coded logging names the cause. */
export class EnqueueWeekError extends Error {
  readonly code: EnqueueWeekErrorCode;
  constructor(code: EnqueueWeekErrorCode, message: string) {
    super(message);
    this.name = 'EnqueueWeekError';
    this.code = code;
  }
}

export function kwmPartitionFor(weekEndDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEndDate)) throw new EnqueueWeekError('enqueue_week_bad_date', 'weekEndDate must be YYYY-MM-DD');
  return `keyword_weekly_metrics_${weekEndDate.slice(0, 4)}`;
}

export function enqueueWeekStatements(weekEndDate: string): EnqueueWeekStatements {
  const partition = kwmPartitionFor(weekEndDate);
  return {
    upsert: {
      text: `
    WITH week_asins AS (
      SELECT t.asin, MIN(kwm.actual_rank)::int AS best_rank
      FROM ${partition} kwm
      CROSS JOIN LATERAL (VALUES
        (kwm.top_clicked_product_1_asin),
        (kwm.top_clicked_product_2_asin),
        (kwm.top_clicked_product_3_asin)
      ) AS t(asin)
      WHERE kwm.week_end_date = $1::date
        AND t.asin ~ '^[A-Z0-9]{10}$'
        AND (kwm.top_clicked_category_1 IS NULL OR kwm.top_clicked_category_1 <> ALL($4::text[]))
      GROUP BY t.asin
    ), upserted AS (
      INSERT INTO asin_products (asin, best_rank, scope_week, tier, in_scope, next_due_at)
      SELECT asin, best_rank, $1::date, CASE WHEN best_rank <= $2::int THEN 1 ELSE 2 END, true, now()
      FROM week_asins
      ON CONFLICT (asin) DO UPDATE SET
        best_rank = EXCLUDED.best_rank,
        scope_week = EXCLUDED.scope_week,
        in_scope = true,
        next_due_at = CASE
          WHEN EXCLUDED.tier = 1 AND asin_products.tier = 2 AND asin_products.last_fetched_at IS NOT NULL
            THEN LEAST(asin_products.next_due_at, asin_products.last_fetched_at + make_interval(days => $3::int))
          ELSE asin_products.next_due_at END,
        tier = EXCLUDED.tier,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted
    )
    SELECT COUNT(*) FILTER (WHERE inserted)::int AS inserted, COUNT(*) FILTER (WHERE NOT inserted)::int AS updated
    FROM upserted`,
      values: [weekEndDate, TIER1_MAX_RANK, TIER1_REFRESH_DAYS, [...EXCLUDED_CATEGORIES_ARRAY]],
    },
    retire: {
      text: `UPDATE asin_products SET in_scope = false, updated_at = now()
    WHERE in_scope AND (scope_week IS NULL OR scope_week <> $1::date)`,
      values: [weekEndDate],
    },
  };
}

export async function enqueueWeek(client: Queryable, weekEndDate: string, opts: EnqueueWeekOptions = {}): Promise<EnqueueWeekResult> {
  const s = enqueueWeekStatements(weekEndDate);
  let result: Omit<EnqueueWeekResult, 'vacuumed'>;
  await client.query('BEGIN');
  try {
    // The pool's statement timeout may not survive the pooler; set it for this transaction.
    await client.query(`SET LOCAL statement_timeout = '1800s'`);
    await client.query('SELECT pg_advisory_xact_lock($1)', [ENQUEUE_LOCK_KEY]);
    if (!opts.force) {
      const { rows } = await client.query('SELECT max(scope_week)::text AS max_week FROM asin_products');
      const maxWeek = (rows[0] as { max_week: string | null } | undefined)?.max_week ?? null;
      if (maxWeek !== null && weekEndDate < maxWeek) {
        throw new EnqueueWeekError('enqueue_week_older_than_scope', `week ${weekEndDate} is older than the catalog's scope week ${maxWeek}`);
      }
    }
    const up = await client.query(s.upsert.text, s.upsert.values);
    const counts = (up.rows[0] as { inserted: number; updated: number } | undefined) ?? { inserted: 0, updated: 0 };
    if (counts.inserted + counts.updated === 0) {
      throw new EnqueueWeekError('enqueue_week_no_rows', `week ${weekEndDate} has no top-3 ASINs in kwm; retire skipped`);
    }
    const ret = await client.query(s.retire.text, s.retire.values);
    result = { inserted: counts.inserted, updated: counts.updated, retired: ret.rowCount ?? 0 };
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  let vacuumed = false;
  if (opts.vacuum !== false) {
    try {
      await client.query('VACUUM (ANALYZE) asin_products');
      vacuumed = true;
    } catch {
      // Best-effort: the upsert and retire are committed; autovacuum (5% scale factor) covers a miss.
    }
  }
  return { ...result, vacuumed };
}
