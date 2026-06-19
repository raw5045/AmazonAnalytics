/**
 * One-time backfill for keyword_current_summary.search_term_normalized.
 *
 * Migration 0037 adds the (nullable) column to keyword_current_summary and its
 * _stage twin but leaves it NULL. The weekly refresh populates it going forward
 * (see inngest/functions/refreshSummary.ts), but the CURRENTLY-live snapshot
 * stays NULL until the next refresh — so the explorer "search term contains"
 * filter would return nothing. This script fills the live table immediately and
 * builds the trigram GIN that the filter's whole-word (`~`) and broad (`LIKE`)
 * matches ride on.
 *
 * Two steps, both idempotent and safe to re-run:
 *   1. Set-based UPDATE copying search_terms.search_term_normalized (the
 *      canonical normalizeForMatch form) onto every kcs row still NULL. MVCC
 *      means this never blocks explorer SELECTs (readers see the prior row
 *      version). ~3.85M rows, a few minutes.
 *   2. Build the GIN — but ONLY if the column has no GIN yet (a refresh may have
 *      already seeded one). Uses CREATE INDEX CONCURRENTLY so it does NOT take
 *      ACCESS EXCLUSIVE on the live table: explorer queries keep running during
 *      the ~30–60s build. Seeds the rotation with KCS_NORM_GIN_A; the weekly
 *      refresh alternates A/B thereafter (see pickStageGinName).
 *
 * Connection: pg.Pool TCP (neon-http would time out on the multi-minute UPDATE
 * and can't hold CONCURRENTLY). statement_timeout is lifted for both steps.
 *
 * Usage:
 *   pnpm tsx scripts/backfillKcsNormalized.ts --dry-run   # counts only, no writes
 *   pnpm tsx scripts/backfillKcsNormalized.ts             # apply
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool, type PoolClient } from 'pg';
import { KCS_NORM_GIN_A } from '@/inngest/functions/refreshSummary';

const GIN_COLUMN_PREDICATE = `indexdef ILIKE '%using gin%search_term_normalized%'`;

async function findLiveGin(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'keyword_current_summary'
       AND ${GIN_COLUMN_PREDICATE}
     LIMIT 1`,
  );
  return rows[0]?.indexname ?? null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  const client = await pool.connect();

  try {
    // ---- Assess current state ----
    const { rows: countRows } = await client.query<{ total: number; need: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE search_term_normalized IS NULL)::int AS need
       FROM keyword_current_summary`,
    );
    const { total, need } = countRows[0];
    const existingGin = await findLiveGin(client);

    console.log('\n=== backfillKcsNormalized ===');
    console.log(`  kcs rows ................. ${total.toLocaleString()}`);
    console.log(`  search_term_normalized NULL ${need.toLocaleString()} (to backfill)`);
    console.log(`  existing column GIN ...... ${existingGin ?? '(none — will build ' + KCS_NORM_GIN_A + ')'}`);

    if (dryRun) {
      console.log('\n[dry-run] No changes made. Re-run without --dry-run to apply.');
      return;
    }

    // ---- Step 1: populate the column (set-based, MVCC-safe) ----
    if (need === 0) {
      console.log('\nColumn already fully populated — skipping UPDATE.');
    } else {
      console.log(`\nUpdating ${need.toLocaleString()} rows…`);
      const t0 = Date.now();
      // Lift the per-statement timeout for this big UPDATE (this session only).
      await client.query('SET statement_timeout = 0');
      const res = await client.query(
        `UPDATE keyword_current_summary kcs
         SET search_term_normalized = st.search_term_normalized
         FROM search_terms st
         WHERE st.id = kcs.search_term_id
           AND kcs.search_term_normalized IS NULL`,
      );
      console.log(
        `  updated ${(res.rowCount ?? 0).toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }

    // ---- Step 2: build the GIN if absent (CONCURRENTLY — non-blocking) ----
    const ginNow = await findLiveGin(client);
    if (ginNow) {
      console.log(`\nGIN already present (${ginNow}) — skipping build.`);
    } else {
      console.log(`\nBuilding ${KCS_NORM_GIN_A} CONCURRENTLY (explorer stays available)…`);
      const t0 = Date.now();
      // CONCURRENTLY can't run inside a transaction; pg.Pool auto-commits each
      // statement, so this is fine. statement_timeout lifted above persists for
      // the session.
      await client.query('SET statement_timeout = 0');
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${KCS_NORM_GIN_A}
         ON keyword_current_summary USING gin (search_term_normalized gin_trgm_ops)`,
      );
      // CONCURRENTLY leaves an INVALID index if it failed mid-build; verify.
      const { rows: validRows } = await client.query<{ isvalid: boolean }>(
        `SELECT i.indisvalid AS isvalid
         FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = $1`,
        [KCS_NORM_GIN_A],
      );
      const isvalid = validRows[0]?.isvalid ?? false;
      console.log(
        `  built in ${((Date.now() - t0) / 1000).toFixed(1)}s — index valid: ${isvalid}`,
      );
      if (!isvalid) {
        console.error(
          `  WARNING: ${KCS_NORM_GIN_A} is INVALID (CONCURRENTLY build interrupted). ` +
            `Drop it (DROP INDEX ${KCS_NORM_GIN_A};) and re-run this script.`,
        );
        process.exitCode = 1;
      }
    }

    console.log('\nDone.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
