/**
 * Diagnostic: run EXPLAIN (ANALYZE, BUFFERS) on the rank_at_*w lookup
 * shape so we know exactly what plan Postgres picks.
 *
 * Things we care about in the output:
 *   - Index Scan vs Index Only Scan (heap fetches yes/no)
 *   - "Heap Fetches: N" counter
 *   - shared hit / shared read counts (I/O breakdown)
 *   - "Subplans Removed by ..." (partition pruning)
 *   - Per-row latency (total / loops)
 *
 * To keep the EXPLAIN ANALYZE itself reasonably fast we scope to active
 * terms with current_rank < 100000 (top-100k SFR). The plan shape should
 * generalize to the full 3.84M because the join is the same; the absolute
 * numbers will scale roughly linearly.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    statement_timeout: 600_000,
  });
  const client = await pool.connect();

  try {
    // Bring stats up to date so the planner sees realistic cardinalities.
    console.log('-- ANALYZE keyword_current_summary');
    await client.query('ANALYZE keyword_current_summary');

    const variants = [
      {
        label: 'rank_at_4w shape, top-100k current_rank only',
        sql: `
          EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT TEXT)
          SELECT
            kcs.search_term_id,
            k.actual_rank
          FROM keyword_current_summary kcs
          JOIN keyword_weekly_metrics k
            ON k.search_term_id = kcs.search_term_id
            AND k.week_end_date = (kcs.current_week_end_date - INTERVAL '28 days')::date
          WHERE kcs.current_rank < 100000
        `,
      },
      {
        label: 'rank_at_52w shape, top-100k current_rank only',
        sql: `
          EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT TEXT)
          SELECT
            kcs.search_term_id,
            k.actual_rank
          FROM keyword_current_summary kcs
          JOIN keyword_weekly_metrics k
            ON k.search_term_id = kcs.search_term_id
            AND k.week_end_date = (kcs.current_week_end_date - INTERVAL '364 days')::date
          WHERE kcs.current_rank < 100000
        `,
      },
    ];

    for (const v of variants) {
      console.log(`\n=== ${v.label} ===\n`);
      const res = await client.query<{ 'QUERY PLAN': string }>(v.sql);
      for (const row of res.rows) {
        console.log(row['QUERY PLAN']);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
