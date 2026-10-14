// lib/baCategory/buildCrosswalk.ts
/**
 * Build the Keepa-path → Brand Analytics crosswalk for one report week (spec 2026-10-14 §5).
 *
 * computeCrosswalk (read-only): one vote per product — the mode of Top Clicked Category #1 over the
 * keywords where the product is the #1 clicked product (the case the report nearly guarantees), joined
 * to the catalog and grouped by the product's path — plus the catalog's distinct paths; assignCodes
 * decides one code per path. writeCrosswalk: TRUNCATE + INSERT in one transaction (readers wait for the
 * commit and then see the new rows; nothing is ever half-written). buildCrosswalk = both, then a
 * best-effort ANALYZE; re-running a week is idempotent.
 *
 * `client` must be ONE dedicated connection (never a Pool): the write is a transaction. Callers: the
 * import phase ba_crosswalk_build (inngest/functions/importFile.ts) and scripts/buildBaCrosswalk.ts.
 * The callers set the statement timeout (30 minutes in the import, 10 in the script).
 */
import { assignCodes, type CrosswalkRow, type CrosswalkVote } from './assignCodes';
import { kwmPartitionFor, type Queryable, type SqlStatement } from '@/lib/topAsins/buildWeek';

export type BaCrosswalkErrorCode = 'ba_crosswalk_bad_date' | 'ba_crosswalk_bad_client' | 'ba_crosswalk_no_votes';
export class BaCrosswalkError extends Error {
  constructor(public readonly code: BaCrosswalkErrorCode, message: string) { super(message); this.name = 'BaCrosswalkError'; }
}

export interface CrosswalkStats {
  week: string;
  /** Rows written: catalog paths that got a code. */
  paths: number;
  /** Paths decided by their own votes. */
  direct: number;
  /** Paths decided by an ancestor's votes. */
  backedOff: number;
  /** Catalog paths that got no row (their department has no vote). */
  uncoded: number;
  /** Products that voted (one vote each). */
  trainingProducts: number;
  /** Distinct codes among the rows. */
  codes: number;
}

const ASIN_RE = "'^[A-Z0-9]{10}$'";

/** The week's votes: one per product (the mode of its category #1), grouped by its path and code. */
export function votesSql(week: string): SqlStatement {
  const partition = kwmPartitionFor(week);
  return {
    text: `SELECT a.category_path AS path, v.code, count(*)::int AS products
FROM (
  SELECT m.top_clicked_product_1_asin AS asin, mode() WITHIN GROUP (ORDER BY m.top_clicked_category_1) AS code
  FROM ${partition} m
  WHERE m.week_end_date = $1::date AND m.top_clicked_product_1_asin ~ ${ASIN_RE} AND m.top_clicked_category_1 IS NOT NULL
  GROUP BY 1
) v
JOIN asin_products a ON a.asin = v.asin
WHERE a.category_path IS NOT NULL
GROUP BY 1, 2`,
    values: [week],
  };
}

/** Every path the crosswalk must decide: the catalog's distinct paths (fetched products only have one). */
export const CATALOG_PATHS_SQL = 'SELECT DISTINCT category_path AS path FROM asin_products WHERE category_path IS NOT NULL';

export async function computeCrosswalk(client: Queryable, week: string): Promise<{ rows: CrosswalkRow[]; stats: CrosswalkStats }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new BaCrosswalkError('ba_crosswalk_bad_date', 'week must be YYYY-MM-DD');
  const votes = votesSql(week);
  const voteRows = (await client.query(votes.text, votes.values)).rows as CrosswalkVote[];
  if (voteRows.length === 0) throw new BaCrosswalkError('ba_crosswalk_no_votes', `week ${week} has no slot-1 rows with a category (not imported?)`);
  const catalogPaths = ((await client.query(CATALOG_PATHS_SQL)).rows as Array<{ path: string }>).map((r) => r.path);
  const rows = assignCodes(voteRows, catalogPaths);
  const direct = rows.filter((r) => r.sourcePath === r.categoryPath).length;
  return {
    rows,
    stats: {
      week,
      paths: rows.length,
      direct,
      backedOff: rows.length - direct,
      uncoded: new Set(catalogPaths).size - rows.length,
      trainingProducts: voteRows.reduce((n, v) => n + v.products, 0),
      codes: new Set(rows.map((r) => r.code)).size,
    },
  };
}

/** Rows per INSERT (24k paths today, so three statements); each binds five arrays and the week. */
export const WRITE_CHUNK = 10_000;

export function insertSql(rows: readonly CrosswalkRow[], week: string): SqlStatement {
  return {
    text: `INSERT INTO ba_category_crosswalk (category_path, code, source_path, votes, share_pct, week_end_date)
SELECT r.category_path, r.code, r.source_path, r.votes, r.share_pct, $6::date
FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::smallint[]) AS r(category_path, code, source_path, votes, share_pct)`,
    values: [rows.map((r) => r.categoryPath), rows.map((r) => r.code), rows.map((r) => r.sourcePath), rows.map((r) => r.votes), rows.map((r) => r.sharePct), week],
  };
}

/** TRUNCATE + INSERT in one transaction: readers queue on the truncate's lock for the moment it takes and then see the new rows. */
export async function writeCrosswalk(client: Queryable, rows: readonly CrosswalkRow[], week: string): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query('TRUNCATE ba_category_crosswalk');
    let written = 0;
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const ins = insertSql(rows.slice(i, i + WRITE_CHUNK), week);
      written += (await client.query(ins.text, ins.values)).rowCount ?? 0;
    }
    await client.query('COMMIT');
    return written;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function buildCrosswalk(client: Queryable, week: string): Promise<CrosswalkStats> {
  if ('totalCount' in client) throw new BaCrosswalkError('ba_crosswalk_bad_client', 'buildCrosswalk needs one dedicated connection, not a Pool');
  const { rows, stats } = await computeCrosswalk(client, week);
  await writeCrosswalk(client, rows, week);
  // Best-effort: the write is committed; the table is small and autovacuum's analyze covers a miss.
  await client.query('ANALYZE ba_category_crosswalk').catch(() => undefined);
  return stats;
}
