// lib/products/buildKeywordCounts.ts
/**
 * Writes asin_products.keyword_count (spec 2026-10-23 §5): the current week's count of keywords the product
 * is a top-3 clicked product for, from keyword_top_asins (rebuilt by top_asins_build, current week only).
 * Runs weekly as the import's keyword_counts_build phase right after top_asins_build, and by hand
 * (scripts/buildKeywordCounts.ts). Two statements in one transaction: set the changed counts, zero the
 * products that dropped out. Only changed rows are written, so a quiet week writes little. Idempotent.
 *
 * Concurrency: the always-on Keepa service writes asin_products in batches of 100 rows, and the UPDATEs here
 * row-lock every changed product in their own order, so the two would deadlock (or push a batch write past its
 * 300 s limit). The transaction therefore holds the exclusive form of ENQUEUE_LOCK_KEY before any row lock, as
 * the weekly enqueue upsert does (lib/keepa/enqueueWeek.ts): the service's store transactions take the shared
 * form first (services/keepa/pgStore.ts) and simply wait until the COMMIT. Transaction-scoped, because Neon's
 * pooler does not keep session-level locks.
 *
 * Guard: an empty pair table (not built, a wrong database) would make the second statement zero every count, so
 * the transaction checks first and refuses with keyword_counts_no_rows, writing nothing.
 *
 * Limits: the transaction's statement limit defaults to 600 s (the weekly phase); the by-hand first build, which
 * touches every counted product, passes a longer one. work_mem is raised for the GROUP BY over the ~9.4M-row
 * pair table, as top_asins_build does for its carry.
 *
 * After the COMMIT, a best-effort VACUUM (ANALYZE) asin_products, as the enqueue upsert runs after its own write;
 * outside the transaction (VACUUM cannot run inside one, and a failure must not undo the counts). Every changed
 * count is a non-HOT update (the column is indexed) that leaves a dead tuple and dead index entries: the first
 * build rewrites ~2.5M rows and would otherwise leave ~2M dead (0, asin) entries at the start of the partial
 * keyword-count index's ascending walk until autovacuum got there. The ANALYZE refreshes the column's
 * statistics. A failure only warns, with coded fields only (vacuumed: false), and autovacuum catches up.
 */
import type { Client, PoolClient } from 'pg';
import { errFields } from '@/lib/ask/logSafe';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';

export type KeywordCountsClient = Pick<Client | PoolClient, 'query'>;
export interface KeywordCountsOptions {
  /** The write transaction's statement limit (SET LOCAL statement_timeout), in whole seconds; default 600. */
  statementTimeoutSeconds?: number;
}
export interface KeywordCountsResult {
  updated: number;
  zeroed: number;
  /** The whole call, the VACUUM included. */
  seconds: number;
  /** False when the VACUUM (ANALYZE) after the COMMIT failed (warned; the counts stay committed). */
  vacuumed: boolean;
}

export type KeywordCountsBuildErrorCode = 'keyword_counts_no_rows';
/** Carries a `code` so the import phase's coded log line and the by-hand script name the cause. */
export class KeywordCountsBuildError extends Error {
  constructor(public readonly code: KeywordCountsBuildErrorCode, message: string) {
    super(message);
    this.name = 'KeywordCountsBuildError';
  }
}

const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 600;

/** The guard: does the pair table hold any row at all? */
export const HAS_PAIRS_SQL = 'SELECT EXISTS (SELECT 1 FROM keyword_top_asins) AS any';
export const SET_COUNTS_SQL = `UPDATE asin_products a SET keyword_count = c.n
  FROM (SELECT asin, count(*)::int AS n FROM keyword_top_asins GROUP BY asin) c
  WHERE a.asin = c.asin AND a.keyword_count IS DISTINCT FROM c.n`;
export const ZERO_DROPPED_SQL = `UPDATE asin_products a SET keyword_count = 0
  WHERE a.keyword_count <> 0 AND NOT EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin)`;

export async function buildKeywordCounts(client: KeywordCountsClient, opts: KeywordCountsOptions = {}): Promise<KeywordCountsResult> {
  const limit = opts.statementTimeoutSeconds ?? DEFAULT_STATEMENT_TIMEOUT_SECONDS;
  // Checked before BEGIN; it is also what makes the interpolation into SET below safe (SET takes no bind parameters).
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('buildKeywordCounts: statementTimeoutSeconds must be a positive integer');
  const started = Date.now();
  let updated: number;
  let zeroed: number;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL statement_timeout = '${limit}s'`);
    await client.query("SET LOCAL work_mem = '256MB'");
    // Waits out an in-flight service batch (seconds); a wait past the limit above is a 57014 and rolls back.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ENQUEUE_LOCK_KEY]);
    // Fail-closed: anything but a plain true (no row, a null) refuses as well.
    const pairs = await client.query(HAS_PAIRS_SQL);
    if ((pairs.rows[0] as { any?: unknown } | undefined)?.any !== true) {
      throw new KeywordCountsBuildError('keyword_counts_no_rows', 'keyword_top_asins is empty; refusing to zero every count');
    }
    updated = (await client.query(SET_COUNTS_SQL)).rowCount ?? 0;
    zeroed = (await client.query(ZERO_DROPPED_SQL)).rowCount ?? 0;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  let vacuumed = true;
  try {
    await client.query('VACUUM (ANALYZE) asin_products');
  } catch (e) {
    vacuumed = false;
    const { error, code } = errFields(e);
    console.warn('[keyword-counts] vacuum failed', JSON.stringify({ outcome: 'vacuum_failed', error, code }));
  }
  return { updated, zeroed, seconds: (Date.now() - started) / 1000, vacuumed };
}
