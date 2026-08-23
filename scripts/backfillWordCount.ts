/**
 * One-time gated backfill (owner-run, AFTER migration 0046):
 *   BACKFILL_WORD_COUNT=yes node --env-file=.env.local --import tsx scripts/backfillWordCount.ts
 *
 * Run OUTSIDE the weekly refresh window — the refresh's mass-UPDATE/TRUNCATE
 * work would lock-contend batch-by-batch, and rows inserted behind the
 * cursor would stay NULL until the final assertion fails (the refresh runs
 * ~4.5 hours after an import upload).
 *
 * Fills keyword_current_summary.word_count in batches. Batching doesn't
 * reduce total dead tuples — every row gets rewritten once either way, so
 * dead tuples end up ~4M, ≈100% of the heap, regardless of batch size — it
 * shortens each transaction and keeps locks small instead of holding one
 * lock for a single multi-minute mass UPDATE. Expect the heap to transiently
 * grow to roughly 2x its current on-disk size over the run (each UPDATE
 * leaves the old row version behind as a dead tuple). VACUUM ANALYZE at the
 * end does NOT shrink the file back down — it marks that dead space reusable
 * by future writes, not returned to the OS — and, just as important for the
 * covering index, sets the visibility map, which is REQUIRED for index-only
 * scans against kcs_cat_cover_idx. Ends by asserting zero NULLs remain (the
 * word-filter predicate flip depends on it). The _stage table is NOT
 * backfilled — the next weekly refresh rebuilds it with word_count included.
 *
 * Batches walk the PK in order (keyset pagination — each batch's subquery is
 * an index-range read, never a rescan of already-updated rows), so total
 * work is O(N) regardless of batch count. The UPDATE and the cursor advance
 * run as ONE statement (see the loop) so both read the same MVCC snapshot —
 * two separate round trips could let a concurrent insert/delete shift the
 * window in between and silently skip never-updated rows past the cursor.
 *
 * Connection: pg.Pool TCP with a 30-min statement_timeout, mirroring
 * scripts/applyMigration0046.ts — the neon() HTTP driver's client-side
 * timeout can abort a slow statement mid-flight (a batch UPDATE, or the
 * multi-minute VACUUM) leaving the run half-done with no signal to the
 * caller, so this uses the same TCP pool + long timeout instead.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

async function main() {
  if (process.env.BACKFILL_WORD_COUNT !== 'yes') {
    console.error('Refusing: set BACKFILL_WORD_COUNT=yes to run.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 1_800_000 });
  const c = await pool.connect();
  try {
    const BATCH = 50_000;
    let lastId = '00000000-0000-0000-0000-000000000000';
    let totalUpdated = 0;
    let batchNum = 0;
    const startedAt = Date.now();

    for (;;) {
      batchNum++;
      const t0 = Date.now();

      // One statement, one snapshot: `batch`, `upd`, and the final SELECT
      // all read the same MVCC snapshot, so the cursor (`last`, from the
      // un-filtered batch CTE) and the update count (from the filtered upd
      // CTE) can never disagree about what was in the window — unlike two
      // separate round trips, where a concurrent insert/delete could shift
      // the window in between and silently skip never-updated rows past the
      // cursor. `last` still advances over the FULL window regardless of
      // how many rows `upd` touched (already-backfilled rows or NULL
      // search_term_normalized don't hold the cursor back), so the loop
      // can't spin forever re-reading a window with nothing left to update.
      const result = await c.query<{ last: string | null; updated: number }>(
        `WITH batch AS (
           SELECT search_term_id FROM keyword_current_summary
           WHERE search_term_id > $1::uuid
           ORDER BY search_term_id
           LIMIT $2
         ),
         upd AS (
           UPDATE keyword_current_summary k
           SET word_count = (length(k.search_term_normalized) - length(replace(k.search_term_normalized, ' ', '')) + 1)::smallint
           FROM batch b
           WHERE k.search_term_id = b.search_term_id
             AND k.word_count IS NULL
             AND k.search_term_normalized IS NOT NULL
           RETURNING 1
         )
         SELECT MAX(b.search_term_id)::text AS last, (SELECT COUNT(*)::int FROM upd) AS updated
         FROM batch b`,
        [lastId, BATCH],
      );
      const { last, updated } = result.rows[0];

      totalUpdated += updated;
      const secs = (Date.now() - t0) / 1000;
      console.log(
        `[batch ${batchNum}] cursor ${lastId.slice(0, 8)}… | updated ${updated.toLocaleString()} | ${secs.toFixed(1)}s | total ${totalUpdated.toLocaleString()}`,
      );

      if (last === null) break;
      lastId = last;
    }

    console.log(
      `Backfill loop done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s — ${totalUpdated.toLocaleString()} rows updated across ${batchNum} batch(es).`,
    );

    // VACUUM ANALYZE: reclaims the bloat/churn left by the batched UPDATEs
    // above and — just as important for migration 0046's covering index —
    // sets the visibility map, which is what lets index-only scans against
    // kcs_cat_cover_idx skip the heap entirely. VACUUM cannot run inside a
    // transaction block; this script never issues a BEGIN, so pg.Pool runs
    // each statement autocommitted and this executes fine as-is — same
    // reasoning as the CONCURRENTLY builds in scripts/backfillKcsNormalized.ts.
    console.log('Running VACUUM ANALYZE keyword_current_summary…');
    const vacT0 = Date.now();
    await c.query('VACUUM ANALYZE keyword_current_summary');
    console.log(`VACUUM ANALYZE done in ${((Date.now() - vacT0) / 1000).toFixed(0)}s.`);

    // ---- Assertions ----
    const { rows: checkRows } = await c.query<{ remaining_null: number; normalized_null: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE word_count IS NULL AND search_term_normalized IS NOT NULL)::int AS remaining_null,
         COUNT(*) FILTER (WHERE search_term_normalized IS NULL)::int AS normalized_null
       FROM keyword_current_summary`,
    );
    const { remaining_null, normalized_null } = checkRows[0];
    console.log(`Rows with search_term_normalized IS NULL (informational, never backfillable): ${normalized_null.toLocaleString()}`);
    console.log(`Rows with word_count still NULL and backfillable: ${remaining_null.toLocaleString()}`);

    if (remaining_null !== 0) {
      console.error('ASSERTION FAILED: NULL word_count rows remain — do NOT deploy the predicate flip.');
      process.exit(1);
    }

    console.log('backfill complete — safe to deploy the word-filter predicate flip.');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
