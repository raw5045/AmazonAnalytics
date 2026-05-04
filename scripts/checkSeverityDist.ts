/**
 * Quick distribution check on fake_volume_severity for the last 4 weeks
 * (the only weeks backfilled so far). Per-week + global summary.
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
    console.log('\n=== Severity distribution (last 4 weeks) ===');
    const { rows: weekly } = await client.query<{
      week_end_date: string;
      severity: string | null;
      c: string;
    }>(
      `
      SELECT week_end_date, fake_volume_severity AS severity, COUNT(*)::bigint c
      FROM keyword_weekly_metrics
      WHERE week_end_date >= (
        SELECT MAX(week_end_date) FROM reporting_weeks WHERE is_complete
      )::date - INTERVAL '21 days'
      GROUP BY week_end_date, fake_volume_severity
      ORDER BY week_end_date, fake_volume_severity NULLS FIRST
      `,
    );
    for (const r of weekly) {
      const ws = String(r.week_end_date).slice(0, 10);
      const label = (r.severity ?? '<NULL>').padEnd(10);
      console.log(` ${ws} | ${label} | ${Number(r.c).toLocaleString()}`);
    }

    console.log('\n=== Global severity distribution (all 53 weeks) ===');
    const { rows: global } = await client.query<{ severity: string | null; c: string }>(
      `SELECT fake_volume_severity AS severity, COUNT(*)::bigint c
       FROM keyword_weekly_metrics
       GROUP BY fake_volume_severity ORDER BY fake_volume_severity NULLS FIRST`,
    );
    for (const r of global) {
      const label = (r.severity ?? '<NULL>').padEnd(10);
      console.log(` ${label} | ${Number(r.c).toLocaleString()}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
