/**
 * Quick read-only check: per-week counts of unbackfilled rows.
 * Uses pg.Pool (TCP) because neon-http times out on the full-table
 * aggregate.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 300_000,
  });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ week: string; total: number; need_backfill: number }>(`
      SELECT week_end_date::text AS week,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NULL)::int AS need_backfill
      FROM keyword_weekly_metrics
      GROUP BY week_end_date
      ORDER BY week_end_date
    `);
    let totalNeed = 0;
    for (const r of rows) {
      const flag = r.need_backfill === 0 ? '✓' : r.need_backfill === r.total ? '○' : '◐';
      console.log(`  ${flag} ${r.week} | ${r.total.toString().padStart(9)} total | ${r.need_backfill.toString().padStart(9)} need backfill`);
      totalNeed += r.need_backfill;
    }
    console.log(`\n  ${rows.length} weeks; ${totalNeed.toLocaleString()} rows need backfill`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
