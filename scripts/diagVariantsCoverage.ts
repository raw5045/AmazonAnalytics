/**
 * How widespread are CSV-dedup variants?
 *   - How many distinct keywords have ANY variant in any week?
 *   - How many keywords have a variant in the most recent week?
 *   - Distribution of duplicate_count (how many duplicate rows did Amazon ship?)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const RECENT_WEEK = '2026-05-02';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 300_000 });
  const c = await pool.connect();
  try {
    const { rows: totals } = await c.query<{
      total_variant_rows: number;
      distinct_keywords_ever: number;
      distinct_keywords_current: number;
      avg_dup_count: number;
      max_dup_count: number;
    }>(`
      WITH t AS (
        SELECT search_term_id, week_end_date, duplicate_count
        FROM import_duplicate_search_terms
      )
      SELECT
        COUNT(*)::int AS total_variant_rows,
        COUNT(DISTINCT search_term_id)::int AS distinct_keywords_ever,
        COUNT(DISTINCT search_term_id) FILTER (WHERE week_end_date = $1::date)::int AS distinct_keywords_current,
        AVG(duplicate_count)::numeric(10,2) AS avg_dup_count,
        MAX(duplicate_count)::int AS max_dup_count
      FROM t
    `, [RECENT_WEEK]);
    const t = totals[0];

    // Total active keywords for reference
    const { rows: active } = await c.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM keyword_current_summary`);
    const totalActive = active[0].n;

    // Distribution of duplicate_count
    const { rows: dist } = await c.query<{ dup_count: number; n: number }>(`
      SELECT duplicate_count::int AS dup_count, COUNT(*)::int AS n
      FROM import_duplicate_search_terms
      WHERE week_end_date = $1::date
      GROUP BY duplicate_count
      ORDER BY duplicate_count
    `, [RECENT_WEEK]);

    console.log(`\n=== Variant coverage (all imported weeks) ===`);
    console.log(`  Total (week, keyword) variant entries: ${t.total_variant_rows.toLocaleString()}`);
    console.log(`  Distinct keywords with variants EVER: ${t.distinct_keywords_ever.toLocaleString()}`);
    console.log(`  Avg duplicate_count: ${t.avg_dup_count}`);
    console.log(`  Max duplicate_count: ${t.max_dup_count}`);

    console.log(`\n=== Most recent week ${RECENT_WEEK} ===`);
    console.log(`  Distinct keywords with variants this week: ${t.distinct_keywords_current.toLocaleString()}`);
    console.log(`  Total active keywords: ${totalActive.toLocaleString()}`);
    console.log(`  Coverage: ${(t.distinct_keywords_current / totalActive * 100).toFixed(2)}% of active keywords have variants in current week`);

    console.log(`\n=== duplicate_count distribution (current week) ===`);
    for (const d of dist) {
      console.log(`  ${d.dup_count}: ${d.n.toLocaleString().padStart(8)}`);
    }
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
