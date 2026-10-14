// lib/baCategory/buildCrosswalk.ts
/**
 * Build the Keepa-path → Brand Analytics crosswalk for one report week (spec 2026-10-14 §5).
 *
 * computeCrosswalk (read-only): one vote per product — the mode of Top Clicked Category #1 over the
 * keywords where the product is the #1 clicked product (the case the report nearly guarantees), joined
 * to the catalog and grouped by the product's path — plus the catalog's distinct paths, both read in one
 * REPEATABLE READ, READ ONLY transaction; assignCodes decides one code per path. writeCrosswalk: under a
 * self-exclusive table lock, refuses a week older than the built one, then DELETE + INSERT in one
 * transaction (readers keep the previous rows until COMMIT, then see the new ones; nothing is ever
 * half-written). buildCrosswalk = both, then a best-effort VACUUM (ANALYZE); re-running a week is idempotent.
 *
 * `client` must be ONE dedicated connection (never a Pool): both steps are transactions. Each sets its own
 * limits with SET LOCAL: the pool's statement_timeout does not bind through Neon's pooler.
 * Callers: the import phase ba_crosswalk_build (inngest/functions/importFile.ts) and scripts/buildBaCrosswalk.ts.
 */
import { assignCodes, type CrosswalkRow, type CrosswalkVote } from './assignCodes';
import { kwmPartitionFor, type Queryable, type SqlStatement } from '@/lib/topAsins/buildWeek';

export type BaCrosswalkErrorCode = 'ba_crosswalk_bad_date' | 'ba_crosswalk_bad_client' | 'ba_crosswalk_no_votes' | 'ba_crosswalk_older_than_built';
export class BaCrosswalkError extends Error {
  constructor(public readonly code: BaCrosswalkErrorCode, message: string) { super(message); this.name = 'BaCrosswalkError'; }
}

export interface CrosswalkStats {
  week: string;
  /** Rows written: catalog paths that got a code. */
  paths: number;
  /** Paths decided at the path itself: by its own products, or by its subtree there when it has too few of its own. */
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

/**
 * The week's votes: one per product (the mode of its category #1; a tie goes to the smaller code in code-unit order,
 * as assignCodes breaks ties, hence COLLATE "C"), grouped by its path and code.
 */
export function votesSql(week: string): SqlStatement {
  const partition = kwmPartitionFor(week);
  return {
    text: `SELECT a.category_path AS path, v.code, count(*)::int AS products
FROM (
  SELECT m.top_clicked_product_1_asin AS asin, mode() WITHIN GROUP (ORDER BY m.top_clicked_category_1 COLLATE "C") AS code
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

/** Every path the crosswalk must decide: the catalog's distinct paths (only fetched products have one). */
export const CATALOG_PATHS_SQL = 'SELECT DISTINCT category_path AS path FROM asin_products WHERE category_path IS NOT NULL';

/** Both steps open a transaction, so a Pool (whose queries may land on different connections) is refused. */
function assertDedicated(client: Queryable, fn: string): void {
  if ('totalCount' in client) throw new BaCrosswalkError('ba_crosswalk_bad_client', `${fn} needs one dedicated connection, not a Pool`);
}

/**
 * The two reads in one REPEATABLE READ, READ ONLY transaction: one snapshot, so every voting path is among the
 * catalog paths (a week with votes always yields rows), and room for SET LOCAL, because the pool's
 * statement_timeout does not bind through Neon's pooler (arc 9's diag query ran 86 minutes under one). work_mem
 * as in lib/topAsins/buildWeek.ts: the votes aggregate sorts the week's ~3M slot-1 rows by ASIN.
 */
async function readInputs(client: Queryable, week: string): Promise<{ voteRows: CrosswalkVote[]; catalogPaths: string[] }> {
  const votes = votesSql(week);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '1800s'");
    await client.query("SET LOCAL work_mem = '256MB'");
    const voteRows = (await client.query(votes.text, votes.values)).rows as CrosswalkVote[];
    if (voteRows.length === 0) throw new BaCrosswalkError('ba_crosswalk_no_votes', `week ${week} has no slot-1 rows with a category (not imported?)`);
    const catalogPaths = ((await client.query(CATALOG_PATHS_SQL)).rows as Array<{ path: string }>).map((r) => r.path);
    await client.query('COMMIT');
    return { voteRows, catalogPaths };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function computeCrosswalk(client: Queryable, week: string): Promise<{ rows: CrosswalkRow[]; stats: CrosswalkStats }> {
  assertDedicated(client, 'computeCrosswalk');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new BaCrosswalkError('ba_crosswalk_bad_date', 'week must be YYYY-MM-DD');
  const { voteRows, catalogPaths } = await readInputs(client, week);
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

/**
 * Replace the rows in one transaction: SET LOCAL limits → LOCK TABLE in SHARE ROW EXCLUSIVE MODE (builders queue on
 * it; readers' ACCESS SHARE never waits) → the guard (a week older than the built one is refused) → DELETE → the
 * INSERTs (WRITE_CHUNK rows each) → COMMIT. DELETE, not TRUNCATE: TRUNCATE's ACCESS EXCLUSIVE lock would queue every
 * reader (each ASIN page's facts join, the broad search) behind any in-flight one, and TRUNCATE is not MVCC-safe
 * (a snapshot older than the COMMIT would see an empty table). The 24k dead rows are vacuumed after the COMMIT.
 */
export async function writeCrosswalk(client: Queryable, rows: readonly CrosswalkRow[], week: string): Promise<number> {
  assertDedicated(client, 'writeCrosswalk');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '1800s'");
    // Builds queue on this self-exclusive lock (readers' ACCESS SHARE never waits on it), so the guard below reads
    // what the last build committed. A wait past 120 s (another build, a migration) is a 55P03: it rolls back.
    await client.query("SET LOCAL lock_timeout = '120s'");
    await client.query('LOCK TABLE ba_category_crosswalk IN SHARE ROW EXCLUSIVE MODE');
    // A late re-import of an older week must not relearn the mapping from older data; the built week rebuilds.
    const built = await client.query('SELECT max(week_end_date) > $1::date AS older FROM ba_category_crosswalk', [week]);
    if ((built.rows[0] as { older: boolean | null } | undefined)?.older === true) {
      throw new BaCrosswalkError('ba_crosswalk_older_than_built', `week ${week} is older than the built week`);
    }
    await client.query('DELETE FROM ba_category_crosswalk');
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
  const { rows, stats } = await computeCrosswalk(client, week); // refuses a Pool and a malformed week before any query
  await writeCrosswalk(client, rows, week);
  // Best-effort, after the COMMIT: reclaims the replaced rows and refreshes the planner statistics and the
  // visibility map (the code index's index-only scans); autovacuum covers a miss.
  await client.query('VACUUM (ANALYZE) ba_category_crosswalk').catch(() => undefined);
  return stats;
}
