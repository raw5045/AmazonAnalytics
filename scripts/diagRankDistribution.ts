/**
 * Quick read: how much of kwm is rank > 1M (i.e., functionally
 * no-traffic noise)? Tells us the speedup from skipping those rows
 * in the loose-match backfill.
 *
 * Also breaks down a few thresholds (500K, 1M, 1.5M, 2M) so we can
 * pick a defensible cutoff.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const WEEKS = ['2025-08-30', '2026-04-25'];

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 300_000,
  });
  const c = await pool.connect();
  try {
    for (const w of WEEKS) {
      const partition = `keyword_weekly_metrics_${w.slice(0, 4)}`;
      console.log(`\n=== ${w}  (${partition}) ===`);

      const { rows } = await c.query<{
        total: number;
        rank_le_100k: number;
        rank_le_500k: number;
        rank_le_1m: number;
        rank_le_1_5m: number;
        rank_le_2m: number;
        max_rank: number;
      }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE actual_rank <= 100000)::int  AS rank_le_100k,
           COUNT(*) FILTER (WHERE actual_rank <= 500000)::int  AS rank_le_500k,
           COUNT(*) FILTER (WHERE actual_rank <= 1000000)::int AS rank_le_1m,
           COUNT(*) FILTER (WHERE actual_rank <= 1500000)::int AS rank_le_1_5m,
           COUNT(*) FILTER (WHERE actual_rank <= 2000000)::int AS rank_le_2m,
           MAX(actual_rank)::int AS max_rank
         FROM ${partition}
         WHERE week_end_date = $1::date`,
        [w],
      );
      const r = rows[0];
      const pct = (n: number) => `${(n / r.total * 100).toFixed(1)}%`;
      console.log(`  total: ${r.total.toLocaleString()}  (max rank: ${r.max_rank.toLocaleString()})`);
      console.log(`  rank ≤ 100K:   ${r.rank_le_100k.toLocaleString().padStart(11)}  (${pct(r.rank_le_100k)})`);
      console.log(`  rank ≤ 500K:   ${r.rank_le_500k.toLocaleString().padStart(11)}  (${pct(r.rank_le_500k)})`);
      console.log(`  rank ≤ 1M:     ${r.rank_le_1m.toLocaleString().padStart(11)}  (${pct(r.rank_le_1m)}) ← user proposal`);
      console.log(`  rank ≤ 1.5M:   ${r.rank_le_1_5m.toLocaleString().padStart(11)}  (${pct(r.rank_le_1_5m)})`);
      console.log(`  rank ≤ 2M:     ${r.rank_le_2m.toLocaleString().padStart(11)}  (${pct(r.rank_le_2m)})`);
      console.log(`  rank > 1M (skipped): ${(r.total - r.rank_le_1m).toLocaleString()}  (${pct(r.total - r.rank_le_1m)})`);
    }
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
