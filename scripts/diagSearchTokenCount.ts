/**
 * How many non-stopword tokens do search terms have?
 * Decides how wide the search_term_loose_requirements table needs to be.
 *
 * Only counts search_terms that have at least one kwm row with rank <= 1M
 * (the population we'll actually need to backfill).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 600_000,
  });
  const c = await pool.connect();
  try {
    // Need a representative sample. Use a recent week with full data.
    const week = '2025-08-30';
    const partition = 'keyword_weekly_metrics_2025';

    console.log(`\nToken-count distribution for search_terms with rank <= 1M in ${week}\n`);

    const { rows } = await c.query<{
      max_tokens: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
      p99_9: number;
      ge_8: number;
      ge_10: number;
      ge_12: number;
      total_terms: number;
    }>(
      `WITH term_tokens AS (
         SELECT
           kwm.search_term_id,
           cardinality(loose_search_tokens(st.search_term_normalized)) AS n_tokens
         FROM ${partition} kwm
         JOIN search_terms st ON st.id = kwm.search_term_id
         WHERE kwm.week_end_date = $1::date
           AND kwm.actual_rank <= 1000000
       )
       SELECT
         MAX(n_tokens)::int AS max_tokens,
         percentile_disc(0.50) WITHIN GROUP (ORDER BY n_tokens)::int AS p50,
         percentile_disc(0.90) WITHIN GROUP (ORDER BY n_tokens)::int AS p90,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY n_tokens)::int AS p95,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY n_tokens)::int AS p99,
         percentile_disc(0.999) WITHIN GROUP (ORDER BY n_tokens)::int AS p99_9,
         COUNT(*) FILTER (WHERE n_tokens >= 8)::int AS ge_8,
         COUNT(*) FILTER (WHERE n_tokens >= 10)::int AS ge_10,
         COUNT(*) FILTER (WHERE n_tokens >= 12)::int AS ge_12,
         COUNT(*)::int AS total_terms
       FROM term_tokens`,
      [week],
    );

    const r = rows[0];
    const pct = (n: number) => `${(n / r.total_terms * 100).toFixed(2)}%`;
    console.log(`  total terms (rank <= 1M): ${r.total_terms.toLocaleString()}`);
    console.log(`  max non-stopword tokens: ${r.max_tokens}`);
    console.log(`  p50: ${r.p50}, p90: ${r.p90}, p95: ${r.p95}, p99: ${r.p99}, p99.9: ${r.p99_9}`);
    console.log(`  with >= 8 tokens (overflow if slots=8):   ${r.ge_8.toLocaleString().padStart(10)} (${pct(r.ge_8)})`);
    console.log(`  with >= 10 tokens (overflow if slots=10): ${r.ge_10.toLocaleString().padStart(10)} (${pct(r.ge_10)})`);
    console.log(`  with >= 12 tokens (overflow if slots=12): ${r.ge_12.toLocaleString().padStart(10)} (${pct(r.ge_12)})`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
