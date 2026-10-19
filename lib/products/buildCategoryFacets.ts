// lib/products/buildCategoryFacets.ts
/**
 * Rebuild product_category_facets (spec 2026-10-19 §5): one row per distinct catalog path among the rows the
 * Products page can show, with its department and product count, replaced in ONE transaction so readers keep
 * the previous rows until COMMIT and never see a half-written list. Callers: the import phase
 * category_facets_build (inngest/functions/importFile.ts) and scripts/buildProductCategoryFacets.ts.
 *
 * The write: BEGIN → SET LOCAL limits → LOCK TABLE in SHARE ROW EXCLUSIVE MODE (builders queue on it; readers'
 * ACCESS SHARE never waits) → DELETE (not TRUNCATE: its ACCESS EXCLUSIVE lock would queue every reader, and it
 * is not MVCC-safe) → INSERT … SELECT … GROUP BY → the stats → COMMIT, then a best-effort
 * VACUUM (ANALYZE, TRUNCATE false). Grouping by (category_path, category_root) under a primary key on
 * category_path alone: a path that ever carried two roots fails the INSERT (23505) instead of storing a wrong
 * department; today none does (measured 2026-10-19: 0 of 1,176,481 rows).
 *
 * `client` must be ONE dedicated connection (never a Pool): each function is a transaction, and SET LOCAL is
 * the only limit that binds through Neon's pooler.
 */
import type { Queryable } from '@/lib/topAsins/buildWeek';

export type FacetsBuildErrorCode = 'facets_bad_client';
export class FacetsBuildError extends Error {
  constructor(public readonly code: FacetsBuildErrorCode, message: string) {
    super(message);
    this.name = 'FacetsBuildError';
  }
}

export interface FacetsBuildStats {
  /** Rows written: distinct paths. */
  paths: number;
  /** Distinct departments among them. */
  departments: number;
  /** Catalog rows behind them (the sum of product_count). */
  products: number;
}

/** The membership rule of the lists (the rows the Products page can show), as a WHERE body. */
export const FACETS_SCOPE_SQL = "in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND category_root IS NOT NULL";

/** The facets as a SELECT: the INSERT and the dry run both read exactly these three columns. */
export const FACETS_SELECT_SQL = `SELECT category_path, category_root AS department, count(*)::int AS product_count
FROM asin_products
WHERE ${FACETS_SCOPE_SQL}
GROUP BY category_path, category_root`;

export const FACETS_INSERT_SQL = `INSERT INTO product_category_facets (category_path, department, product_count)
${FACETS_SELECT_SQL}`;

/** The stats over `source`: the table after the INSERT, or the SELECT itself for a dry run. */
export function facetStatsSql(source: 'table' | 'select'): string {
  const from = source === 'table' ? 'product_category_facets' : `(${FACETS_SELECT_SQL}) f`;
  return `SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, coalesce(sum(product_count), 0)::int AS products FROM ${from}`;
}

function assertDedicated(client: Queryable, fn: string): void {
  if ('totalCount' in client) throw new FacetsBuildError('facets_bad_client', `${fn} needs one dedicated connection, not a Pool`);
}

function readStats(rows: unknown[]): FacetsBuildStats {
  const r = rows[0] as Partial<FacetsBuildStats> | undefined;
  return { paths: r?.paths ?? 0, departments: r?.departments ?? 0, products: r?.products ?? 0 };
}

/** What a build would write, without writing: the stats of the SELECT in one bounded read-only transaction. */
export async function computeProductCategoryFacets(client: Queryable): Promise<FacetsBuildStats> {
  assertDedicated(client, 'computeProductCategoryFacets');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '600s'");
    const stats = readStats((await client.query(facetStatsSql('select'))).rows);
    await client.query('COMMIT');
    return stats;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Replace the rows in one transaction and return the stats of what was written; then a best-effort VACUUM. */
export async function buildProductCategoryFacets(client: Queryable): Promise<FacetsBuildStats> {
  assertDedicated(client, 'buildProductCategoryFacets');
  await client.query('BEGIN');
  let stats: FacetsBuildStats;
  try {
    await client.query("SET LOCAL statement_timeout = '600s'");
    // Builds queue on the self-exclusive lock below; a wait past 120 s (another build, a migration) is a 55P03: it rolls back.
    await client.query("SET LOCAL lock_timeout = '120s'");
    await client.query('LOCK TABLE product_category_facets IN SHARE ROW EXCLUSIVE MODE');
    await client.query('DELETE FROM product_category_facets');
    await client.query(FACETS_INSERT_SQL);
    stats = readStats((await client.query(facetStatsSql('table'))).rows);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  // Best-effort, after the COMMIT, as the crosswalk build does: reclaims the replaced rows and refreshes the
  // planner statistics and the visibility map (the department index's index-only scans); autovacuum covers a
  // miss. TRUNCATE false: no page-trim lock, so readers never wait.
  await client.query('VACUUM (ANALYZE, TRUNCATE false) product_category_facets').catch(() => undefined);
  return stats;
}
