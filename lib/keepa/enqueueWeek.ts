// lib/keepa/enqueueWeek.ts
/**
 * Enqueue a week's top-3 ASINs for the Keepa service (spec 2026-10-05 §6.1).
 *
 * One upsert over the week's kwm partition: every top-3 ASIN of the week (same category
 * exclusions as the old enrichment) gets its best keyword rank, the scope week, its tier
 * (1 = rank ≤ TIER1_MAX_RANK, weekly; 2 = the rest) and in_scope = true. Brand-new ASINs start
 * never-fetched and due now. An ASIN moving from tier 2 to tier 1 that was fetched before is
 * pulled forward to a weekly due date. Then every row not seen this week is flagged out of
 * scope — kept, never deleted.
 *
 * Callers: the import's completion step (inngest/functions/importFile.ts), the 0050 seed
 * script, and scripts/fireEnqueueWeek.ts.
 */
import { EXCLUDED_CATEGORIES_ARRAY } from './categoryExclusions';
import { TIER1_MAX_RANK, TIER1_REFRESH_DAYS } from './lanes';

export interface SqlStatement {
  text: string;
  values: unknown[];
}
export interface EnqueueWeekStatements {
  upsert: SqlStatement;
  retire: SqlStatement;
}
/** The slice of pg's Pool/PoolClient the runner needs — keeps the unit test free of a database. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export function kwmPartitionFor(weekEndDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEndDate)) throw new Error('weekEndDate must be YYYY-MM-DD');
  return `keyword_weekly_metrics_${weekEndDate.slice(0, 4)}`;
}

export function enqueueWeekStatements(weekEndDate: string): EnqueueWeekStatements {
  const partition = kwmPartitionFor(weekEndDate);
  const excl = EXCLUDED_CATEGORIES_ARRAY;
  const placeholders = excl.map((_, i) => `$${i + 4}`).join(',');
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
        AND t.asin IS NOT NULL
        AND (kwm.top_clicked_category_1 IS NULL OR kwm.top_clicked_category_1 NOT IN (${placeholders}))
      GROUP BY t.asin
    )
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
      updated_at = now()`,
      values: [weekEndDate, TIER1_MAX_RANK, TIER1_REFRESH_DAYS, ...excl],
    },
    retire: {
      text: `UPDATE asin_products SET in_scope = false, updated_at = now()
    WHERE in_scope AND (scope_week IS NULL OR scope_week <> $1::date)`,
      values: [weekEndDate],
    },
  };
}

export async function enqueueWeek(
  client: Queryable,
  weekEndDate: string,
): Promise<{ upserted: number; retired: number }> {
  const s = enqueueWeekStatements(weekEndDate);
  const up = await client.query(s.upsert.text, s.upsert.values);
  const ret = await client.query(s.retire.text, s.retire.values);
  return { upserted: up.rowCount ?? 0, retired: ret.rowCount ?? 0 };
}
