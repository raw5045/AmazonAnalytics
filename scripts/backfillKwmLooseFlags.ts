/**
 * Backfill keyword_in_title_*_loose + keyword_title_match_count_loose
 * across all weeks in keyword_weekly_metrics. Uses migration 0015's
 * Postgres functions.
 *
 * Strategy per week:
 *   1. Build temp table of distinct non-NULL titles -> loose_title_forms()
 *      so the (expensive) normalization runs once per distinct title,
 *      not once per kwm row.
 *   2. Single UPDATE using a MATERIALIZED CTE that:
 *      - Computes f1/f2/f3 once each (no re-evaluation in the count).
 *      - Skips loose computation when Amazon's strict flag is TRUE
 *        (loose is a superset of strict, so this is a free correct shortcut).
 *      - Joins to the temp title-forms table for cached lookups.
 *   3. Resume marker: keyword_title_match_count_loose IS NULL.
 *      (Was previously keyword_in_title_1_loose IS NULL — a bug, since
 *      that column legitimately stays NULL when title #1 is NULL.)
 *
 * Idempotent. Connection: pg.Pool (TCP); neon-http times out on
 * multi-min UPDATEs.
 *
 * Usage: pnpm tsx scripts/backfillKwmLooseFlags.ts
 *
 * Optional environment variable WEEK_FILTER limits the run to a single
 * week (used by the Task 7 trial run). Example:
 *   WEEK_FILTER=2025-08-30 pnpm tsx scripts/backfillKwmLooseFlags.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const weekFilter = process.env.WEEK_FILTER ?? null;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 1_800_000, // 30 min ceiling per statement
  });
  const client = await pool.connect();

  try {
    console.log('\n=== Weeks to backfill ===');
    const { rows: weeks } = await client.query<{
      week_end_date: string;
      total: number;
      need_backfill: number;
    }>(
      `SELECT
         week_end_date::text,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NULL)::int AS need_backfill
       FROM keyword_weekly_metrics
       GROUP BY week_end_date
       ORDER BY week_end_date`,
    );
    let todo = weeks.filter((w) => w.need_backfill > 0);
    if (weekFilter !== null) {
      todo = todo.filter((w) => w.week_end_date.slice(0, 10) === weekFilter);
      console.log(`  WEEK_FILTER=${weekFilter} → ${todo.length} matching week(s)`);
    }
    const totalNeed = todo.reduce((s, w) => s + w.need_backfill, 0);
    console.log(
      `  ${weeks.length} weeks total; ${todo.length} to process; ${totalNeed.toLocaleString()} rows`,
    );
    if (todo.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const startedAt = Date.now();

    for (let i = 0; i < todo.length; i++) {
      const w = todo[i];
      const ws = w.week_end_date.slice(0, 10);
      const sliceStart = Date.now();

      // Build per-week temp title cache. Use explicit BEGIN/COMMIT so
      // the temp table created inside the transaction is visible to
      // the UPDATE that follows.
      await client.query('BEGIN');

      await client.query(
        `CREATE TEMP TABLE tmp_title_forms ON COMMIT DROP AS
         WITH distinct_titles AS (
           SELECT top_clicked_product_1_title AS title
             FROM keyword_weekly_metrics
             WHERE week_end_date = $1::date AND top_clicked_product_1_title IS NOT NULL
           UNION
           SELECT top_clicked_product_2_title AS title
             FROM keyword_weekly_metrics
             WHERE week_end_date = $1::date AND top_clicked_product_2_title IS NOT NULL
           UNION
           SELECT top_clicked_product_3_title AS title
             FROM keyword_weekly_metrics
             WHERE week_end_date = $1::date AND top_clicked_product_3_title IS NOT NULL
         )
         SELECT title, loose_title_forms(title) AS forms FROM distinct_titles`,
        [ws],
      );
      await client.query('CREATE INDEX ON tmp_title_forms (title)');
      await client.query('ANALYZE tmp_title_forms');
      const { rows: cacheStats } = await client.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM tmp_title_forms',
      );
      const distinctTitles = cacheStats[0]?.n ?? 0;

      // Single materialized-CTE UPDATE for the week. MATERIALIZED
      // forces f1/f2/f3 to evaluate exactly once each (referenced
      // both as columns and inside the count expression).
      const result = await client.query(
        `WITH computed AS MATERIALIZED (
           SELECT
             kwm.ctid,
             CASE
               WHEN kwm.top_clicked_product_1_title IS NULL THEN NULL
               WHEN kwm.keyword_in_title_1 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t1.forms)
             END AS f1,
             CASE
               WHEN kwm.top_clicked_product_2_title IS NULL THEN NULL
               WHEN kwm.keyword_in_title_2 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t2.forms)
             END AS f2,
             CASE
               WHEN kwm.top_clicked_product_3_title IS NULL THEN NULL
               WHEN kwm.keyword_in_title_3 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t3.forms)
             END AS f3
           FROM keyword_weekly_metrics kwm
           JOIN search_terms st ON st.id = kwm.search_term_id
           LEFT JOIN tmp_title_forms t1 ON t1.title = kwm.top_clicked_product_1_title
           LEFT JOIN tmp_title_forms t2 ON t2.title = kwm.top_clicked_product_2_title
           LEFT JOIN tmp_title_forms t3 ON t3.title = kwm.top_clicked_product_3_title
           WHERE kwm.week_end_date = $1::date
             AND kwm.keyword_title_match_count_loose IS NULL
         )
         UPDATE keyword_weekly_metrics kwm
         SET keyword_in_title_1_loose = c.f1,
             keyword_in_title_2_loose = c.f2,
             keyword_in_title_3_loose = c.f3,
             keyword_title_match_count_loose = (
               COALESCE(c.f1::int, 0) + COALESCE(c.f2::int, 0) + COALESCE(c.f3::int, 0)
             )::smallint
         FROM computed c
         WHERE kwm.ctid = c.ctid`,
        [ws],
      );

      await client.query('COMMIT');

      const sliceMs = Date.now() - sliceStart;
      const remaining = todo.length - i - 1;
      const avgMs = (Date.now() - startedAt) / (i + 1);
      const etaMin = Math.round((remaining * avgMs) / 60_000);
      const updated = result.rowCount ?? 0;
      console.log(
        ` [${(i + 1).toString().padStart(2)}/${todo.length}] ${ws} | ${distinctTitles.toLocaleString().padStart(8)} distinct titles | ${updated.toLocaleString().padStart(10)} rows | ${(sliceMs / 1000).toFixed(1).padStart(6)}s | ETA ~${etaMin}m`,
      );
    }

    console.log(`\nTotal elapsed: ${Math.round((Date.now() - startedAt) / 60_000)} min`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
