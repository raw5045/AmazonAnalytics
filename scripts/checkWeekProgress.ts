import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{ filled: number; total: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NOT NULL)::int AS filled,
        COUNT(*)::int AS total
      FROM keyword_weekly_metrics_2025
      WHERE week_end_date = '2025-08-30'::date
    `);
    console.log(`2025-08-30 filled: ${rows[0].filled.toLocaleString()} / ${rows[0].total.toLocaleString()}`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
