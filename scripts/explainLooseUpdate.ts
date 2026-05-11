/**
 * EXPLAIN (no ANALYZE — that would execute the UPDATE) the backfill's
 * UPDATE statement to see what plan Postgres picks.
 *
 * Crucial question: is kwm or search_terms the driving table? If the
 * planner drives from search_terms (3.8M rows), every term gets the
 * loose computation regardless of week. If it drives from kwm filtered
 * to one week (2.6M rows), only that week's rows pay.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    const { rows } = await c.query(`
      EXPLAIN
      UPDATE keyword_weekly_metrics_2025 kwm
      SET (
        keyword_in_title_1_loose,
        keyword_in_title_2_loose,
        keyword_in_title_3_loose,
        keyword_title_match_count_loose
      ) = (
        SELECT (lf).f1, (lf).f2, (lf).f3, (lf).match_count
        FROM loose_title_flags_3(
          st.search_term_normalized,
          kwm.top_clicked_product_1_title,
          kwm.top_clicked_product_2_title,
          kwm.top_clicked_product_3_title,
          kwm.keyword_in_title_1,
          kwm.keyword_in_title_2,
          kwm.keyword_in_title_3
        ) AS lf
      )
      FROM search_terms st
      WHERE kwm.search_term_id = st.id
        AND kwm.week_end_date = '2025-08-30'::date
        AND kwm.keyword_title_match_count_loose IS NULL
    `);
    for (const r of rows) console.log(r['QUERY PLAN']);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
