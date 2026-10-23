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
 * The transaction's statement limit defaults to 600 s (the weekly phase); the by-hand first build, which touches
 * every counted product, passes a longer one. After the COMMIT, a best-effort ANALYZE asin_products refreshes
 * the planner statistics of the rewritten column, outside the transaction so a failure cannot undo the counts:
 * it only warns, and autoanalyze catches up.
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
  /** The whole call, the ANALYZE included. */
  seconds: number;
  /** False when the ANALYZE after the COMMIT failed (warned; the counts stay committed). */
  analyzed: boolean;
}

const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 600;

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
    // Waits out an in-flight service batch (seconds); a wait past the limit above is a 57014 and rolls back.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ENQUEUE_LOCK_KEY]);
    updated = (await client.query(SET_COUNTS_SQL)).rowCount ?? 0;
    zeroed = (await client.query(ZERO_DROPPED_SQL)).rowCount ?? 0;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  let analyzed = true;
  try {
    await client.query('ANALYZE asin_products');
  } catch (e) {
    analyzed = false;
    console.warn('[keyword-counts] analyze failed', JSON.stringify({ outcome: 'analyze_failed', ...errFields(e) }));
  }
  return { updated, zeroed, seconds: (Date.now() - started) / 1000, analyzed };
}
