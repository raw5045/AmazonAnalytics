/**
 * Pre-backfill diagnostic: how many rows would need their fake_volume_severity
 * reset to 'none' when applying the rank > 100,000 threshold rule?
 *
 * Counts per-week + total to estimate backfill cost.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const THRESHOLD = 100_000;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 600_000 });
  const c = await pool.connect();
  try {
    console.log(`\n=== Rows that would change with rank > ${THRESHOLD.toLocaleString()} threshold ===\n`);

    // Total impacted rows (currently non-none severity AND rank > threshold)
    const { rows: tot } = await c.query<{
      total: number;
      to_fix: number;
      critical_to_fix: number;
      warning_to_fix: number;
    }>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE actual_rank > ${THRESHOLD}
            AND fake_volume_severity IS NOT NULL
            AND fake_volume_severity::text != 'none'
        )::int AS to_fix,
        COUNT(*) FILTER (
          WHERE actual_rank > ${THRESHOLD}
            AND fake_volume_severity::text = 'critical'
        )::int AS critical_to_fix,
        COUNT(*) FILTER (
          WHERE actual_rank > ${THRESHOLD}
            AND fake_volume_severity::text = 'warning'
        )::int AS warning_to_fix
      FROM keyword_weekly_metrics
    `);
    const t = tot[0];
    console.log(`Total kwm rows: ${t.total.toLocaleString()}`);
    console.log(`Rows needing severity reset: ${t.to_fix.toLocaleString()}`);
    console.log(`  - currently 'critical': ${t.critical_to_fix.toLocaleString()}`);
    console.log(`  - currently 'warning':  ${t.warning_to_fix.toLocaleString()}`);

    // Per-week distribution for the last 5 weeks
    const { rows: weeks } = await c.query<{ week_end_date: string; to_fix: number; total: number }>(`
      SELECT
        week_end_date::text,
        COUNT(*) FILTER (
          WHERE actual_rank > ${THRESHOLD}
            AND fake_volume_severity::text != 'none'
            AND fake_volume_severity IS NOT NULL
        )::int AS to_fix,
        COUNT(*)::int AS total
      FROM keyword_weekly_metrics
      GROUP BY week_end_date
      ORDER BY week_end_date DESC
      LIMIT 5
    `);
    console.log(`\nLast 5 weeks (to_fix / total):`);
    for (const w of weeks) {
      console.log(`  ${w.week_end_date}: ${w.to_fix.toLocaleString()} / ${w.total.toLocaleString()} (${(w.to_fix/w.total*100).toFixed(1)}%)`);
    }

    // Rough backfill cost estimate: prior reset wrote ~14M rows in ~68 min
    // (cold cache for first week) = ~4.9 ms/row. Real-world UPDATE on a
    // narrow column set is typically faster, but use this as a ceiling.
    const estMinutes = (t.to_fix * 4.9) / 60_000;
    console.log(`\nEstimated backfill time (ceiling, based on prior 4.9 ms/row reset rate): ${estMinutes.toFixed(0)} min`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
