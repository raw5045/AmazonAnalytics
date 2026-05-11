/**
 * Diagnostic: time the per-component cost of the backfill on a small
 * (10k row) sample to figure out where the bottleneck is.
 *
 * Three timed runs, each over the SAME 10k rows:
 *   A. SELECT-only compute (no writes) — measures pure compute cost
 *   B. UPDATE setting all loose columns to NULL — measures pure write cost
 *   C. UPDATE with the actual MATERIALIZED CTE — measures combined cost
 *
 * Also reports HOT update rate via pg_stat_user_tables before/after C.
 *
 * Uses 2025-08-30 week. Picks 10k rows by ORDER BY actual_rank LIMIT.
 * Reverts the writes at the end so the state is unchanged.
 *
 * Usage: pnpm tsx scripts/diagBackfillPerf.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const WEEK = '2025-08-30';
const SAMPLE_SIZE = 10_000;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 600_000,
  });
  const client = await pool.connect();

  try {
    console.log(`\nDiagnosing backfill perf on ${WEEK} (${SAMPLE_SIZE.toLocaleString()} rows)\n`);

    // Build a stable sample (the same 10k rows by ctid) to use across A/B/C.
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE tmp_sample ON COMMIT DROP AS
       SELECT ctid AS row_ctid, search_term_id,
              top_clicked_product_1_title,
              top_clicked_product_2_title,
              top_clicked_product_3_title,
              keyword_in_title_1, keyword_in_title_2, keyword_in_title_3
       FROM keyword_weekly_metrics
       WHERE week_end_date = $1::date
       ORDER BY actual_rank
       LIMIT $2`,
      [WEEK, SAMPLE_SIZE],
    );
    await client.query('CREATE INDEX ON tmp_sample (row_ctid)');
    await client.query('ANALYZE tmp_sample');
    console.log(`Sample built (${SAMPLE_SIZE.toLocaleString()} rows).\n`);

    // Build the title-forms cache (same as the production backfill).
    await client.query(
      `CREATE TEMP TABLE tmp_title_forms ON COMMIT DROP AS
       WITH distinct_titles AS (
         SELECT top_clicked_product_1_title AS title FROM tmp_sample WHERE top_clicked_product_1_title IS NOT NULL
         UNION
         SELECT top_clicked_product_2_title AS title FROM tmp_sample WHERE top_clicked_product_2_title IS NOT NULL
         UNION
         SELECT top_clicked_product_3_title AS title FROM tmp_sample WHERE top_clicked_product_3_title IS NOT NULL
       )
       SELECT title, loose_title_forms(title) AS forms FROM distinct_titles`,
    );
    await client.query('CREATE INDEX ON tmp_title_forms (title)');
    await client.query('ANALYZE tmp_title_forms');
    const { rows: titleStats } = await client.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM tmp_title_forms',
    );
    console.log(`Title cache: ${titleStats[0]?.n.toLocaleString()} distinct titles\n`);

    // === A. SELECT-only compute (pure compute, no writes) ===
    {
      const t0 = Date.now();
      const r = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE
             CASE
               WHEN s.top_clicked_product_1_title IS NULL THEN NULL
               WHEN s.keyword_in_title_1 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t1.forms)
             END IS TRUE
           ) AS f1_true,
           COUNT(*) FILTER (WHERE
             CASE
               WHEN s.top_clicked_product_2_title IS NULL THEN NULL
               WHEN s.keyword_in_title_2 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t2.forms)
             END IS TRUE
           ) AS f2_true
         FROM tmp_sample s
         JOIN search_terms st ON st.id = s.search_term_id
         LEFT JOIN tmp_title_forms t1 ON t1.title = s.top_clicked_product_1_title
         LEFT JOIN tmp_title_forms t2 ON t2.title = s.top_clicked_product_2_title`,
      );
      const ms = Date.now() - t0;
      console.log(`A. SELECT-only compute (2 slots): ${ms}ms  (${(ms / SAMPLE_SIZE * 1000).toFixed(2)}μs/row)`);
      console.log(`   f1_true=${r.rows[0].f1_true}  f2_true=${r.rows[0].f2_true}`);
    }

    // Capture pre-UPDATE stats
    const { rows: preStats } = await client.query<{
      n_tup_upd: string;
      n_tup_hot_upd: string;
    }>(
      `SELECT n_tup_upd::text, n_tup_hot_upd::text
       FROM pg_stat_user_tables
       WHERE relname = 'keyword_weekly_metrics_y2025'`,
    );

    // === B. UPDATE to NULL (pure write cost, no compute) ===
    {
      const t0 = Date.now();
      const r = await client.query(
        `UPDATE keyword_weekly_metrics kwm
         SET keyword_in_title_1_loose = NULL
         FROM tmp_sample s
         WHERE kwm.ctid = s.row_ctid`,
      );
      const ms = Date.now() - t0;
      console.log(`B. UPDATE 1 col to NULL (pure write): ${ms}ms  (${(ms / SAMPLE_SIZE * 1000).toFixed(2)}μs/row)  rows=${r.rowCount}`);
    }

    // === C. The actual production UPDATE shape (MATERIALIZED CTE) ===
    {
      const t0 = Date.now();
      const r = await client.query(
        `WITH computed AS MATERIALIZED (
           SELECT
             s.row_ctid,
             CASE
               WHEN s.top_clicked_product_1_title IS NULL THEN NULL
               WHEN s.keyword_in_title_1 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t1.forms)
             END AS f1,
             CASE
               WHEN s.top_clicked_product_2_title IS NULL THEN NULL
               WHEN s.keyword_in_title_2 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t2.forms)
             END AS f2,
             CASE
               WHEN s.top_clicked_product_3_title IS NULL THEN NULL
               WHEN s.keyword_in_title_3 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t3.forms)
             END AS f3
           FROM tmp_sample s
           JOIN search_terms st ON st.id = s.search_term_id
           LEFT JOIN tmp_title_forms t1 ON t1.title = s.top_clicked_product_1_title
           LEFT JOIN tmp_title_forms t2 ON t2.title = s.top_clicked_product_2_title
           LEFT JOIN tmp_title_forms t3 ON t3.title = s.top_clicked_product_3_title
         )
         UPDATE keyword_weekly_metrics kwm
         SET keyword_in_title_1_loose = c.f1,
             keyword_in_title_2_loose = c.f2,
             keyword_in_title_3_loose = c.f3,
             keyword_title_match_count_loose = (
               COALESCE(c.f1::int, 0) + COALESCE(c.f2::int, 0) + COALESCE(c.f3::int, 0)
             )::smallint
         FROM computed c
         WHERE kwm.ctid = c.row_ctid`,
      );
      const ms = Date.now() - t0;
      console.log(`C. Production UPDATE (MATERIALIZED CTE): ${ms}ms  (${(ms / SAMPLE_SIZE * 1000).toFixed(2)}μs/row)  rows=${r.rowCount}`);
    }

    // Capture post-UPDATE stats (note: requires a moment for stats to flush)
    await new Promise((r) => setTimeout(r, 2000));
    const { rows: postStats } = await client.query<{
      n_tup_upd: string;
      n_tup_hot_upd: string;
    }>(
      `SELECT n_tup_upd::text, n_tup_hot_upd::text
       FROM pg_stat_user_tables
       WHERE relname = 'keyword_weekly_metrics_y2025'`,
    );

    const upsDelta = BigInt(postStats[0].n_tup_upd) - BigInt(preStats[0].n_tup_upd);
    const hotsDelta = BigInt(postStats[0].n_tup_hot_upd) - BigInt(preStats[0].n_tup_hot_upd);
    const hotPct = upsDelta > 0n ? Number((hotsDelta * 10000n) / upsDelta) / 100 : null;
    console.log(`\n   HOT updates: ${hotsDelta.toString()} / ${upsDelta.toString()} (${hotPct?.toFixed(2)}%)`);

    // Rollback so the data is unchanged for the real backfill.
    console.log('\nRolling back (sample data unchanged)...');
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
