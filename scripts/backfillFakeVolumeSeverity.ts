/**
 * One-time backfill of fake_volume_severity + fake_volume_eval_status for
 * existing keyword_weekly_metrics rows.
 *
 * Why we need this: Plan 3.1 introduced two-tier severity but the
 * existing rows have NULL fake_volume_severity. New imports compute it
 * in the kwm INSERT going forward; this script catches up.
 *
 * Strategy: chunk by week_end_date. Each weekly slice is ~2.7-3.9M rows.
 * Each UPDATE filters on `week_end_date = X` (covered by PK index range
 * scan). Re-runnable — only touches rows where severity is still NULL.
 *
 * Wide-row UPDATE on a 140M-row table is heavy: each tuple is rewritten
 * in full. Observed first slice: 10+ minutes due to Neon cold-cache
 * page prefetch. Subsequent slices benefit from warm cache but full-history
 * backfill is realistically 4-9 hours.
 *
 * Args:
 *   LAST_N_WEEKS=N   Limit to the most recent N reporting_weeks (e.g., 4).
 *                    Default: all weeks.
 *
 * Connection: pg.Pool (TCP keepalive) — neon-http would time out.
 *
 * Usage:
 *   pnpm tsx scripts/backfillFakeVolumeSeverity.ts            # all weeks
 *   LAST_N_WEEKS=4 pnpm tsx scripts/backfillFakeVolumeSeverity.ts  # last 4 weeks
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    statement_timeout: 600_000, // 10 min per slice — generous
  });

  const client = await pool.connect();

  try {
    // 1. Get the list of weeks to process. Optionally limit to last N.
    const lastN = process.env.LAST_N_WEEKS ? parseInt(process.env.LAST_N_WEEKS, 10) : null;
    const weekQuery = lastN
      ? `SELECT week_end_date
         FROM reporting_weeks
         WHERE is_complete = true
         ORDER BY week_end_date DESC
         LIMIT ${lastN}`
      : `SELECT week_end_date FROM reporting_weeks WHERE is_complete = true ORDER BY week_end_date`;
    const { rows: weekRowsRaw } = await client.query<{ week_end_date: string }>(weekQuery);
    // If we used LIMIT to get most-recent, reverse so we process oldest -> newest
    const weekRows = lastN ? [...weekRowsRaw].reverse() : weekRowsRaw;
    console.log(`Found ${weekRows.length} week(s) to process${lastN ? ` (last ${lastN} weeks)` : ''}`);

    let totalRowsUpdated = 0;
    const startedAt = Date.now();

    for (let i = 0; i < weekRows.length; i++) {
      const week = weekRows[i].week_end_date;
      const ws = String(week).slice(0, 10);
      const sliceStart = Date.now();

      // Compute severity + eval_status in a single UPDATE per week.
      // Idempotent: only touches rows where severity is still NULL.
      const result = await client.query(
        `
        UPDATE keyword_weekly_metrics
        SET
          fake_volume_severity = CASE
            WHEN top_clicked_product_1_click_share IS NULL
              OR top_clicked_product_1_conversion_share IS NULL
              THEN NULL
            WHEN (top_clicked_product_1_click_share > 20
                  AND top_clicked_product_1_conversion_share < 0.5)
              OR (top_clicked_product_1_click_share > 30
                  AND top_clicked_product_1_conversion_share < 1.0)
              THEN 'critical'::fake_volume_severity
            WHEN (top_clicked_product_1_click_share > 5
                  AND top_clicked_product_1_conversion_share < 0.5)
              OR (top_clicked_product_1_click_share > 10
                  AND top_clicked_product_1_conversion_share < 1.0)
              THEN 'warning'::fake_volume_severity
            ELSE 'none'::fake_volume_severity
          END,
          fake_volume_eval_status = CASE
            WHEN top_clicked_product_1_click_share IS NULL
              THEN 'unknown_missing_click'::fake_volume_eval_status
            WHEN top_clicked_product_1_conversion_share IS NULL
              THEN 'unknown_missing_conversion'::fake_volume_eval_status
            ELSE 'evaluated'::fake_volume_eval_status
          END
        WHERE week_end_date = $1::date
          AND fake_volume_severity IS NULL
        `,
        [week],
      );

      const sliceMs = Date.now() - sliceStart;
      const updated = result.rowCount ?? 0;
      totalRowsUpdated += updated;
      const remaining = weekRows.length - i - 1;
      const avgMs = (Date.now() - startedAt) / (i + 1);
      const etaMin = Math.round((remaining * avgMs) / 60_000);
      console.log(
        ` [${(i + 1).toString().padStart(2)}/${weekRows.length}] ${ws} | ${updated.toLocaleString().padStart(10)} rows | ${(sliceMs / 1000).toFixed(1).padStart(6)}s | ETA ~${etaMin}m`,
      );
    }

    console.log(`\nTotal rows updated: ${totalRowsUpdated.toLocaleString()}`);
    console.log(`Total elapsed: ${Math.round((Date.now() - startedAt) / 60_000)} min`);

    // Sanity check: count by severity
    console.log('\n=== Severity distribution ===');
    const { rows: dist } = await client.query<{ fake_volume_severity: string | null; c: string }>(
      `SELECT fake_volume_severity, COUNT(*)::bigint c
       FROM keyword_weekly_metrics
       GROUP BY fake_volume_severity ORDER BY fake_volume_severity NULLS FIRST`,
    );
    for (const d of dist) {
      const label = d.fake_volume_severity ?? '<NULL>';
      console.log(` ${label.padEnd(12)} ${Number(d.c).toLocaleString()}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
