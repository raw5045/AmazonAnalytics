/**
 * One-time backfill of fake_volume_severity + fake_volume_eval_status for
 * the 140M existing keyword_weekly_metrics rows accumulated during the
 * 53-week historical import.
 *
 * Why we need this: Plan 3.1 introduced two-tier severity but the
 * existing rows have NULL fake_volume_severity (and most also have NULL
 * fake_volume_eval_status). New imports compute these in the kwm INSERT
 * going forward; this script catches up the existing data.
 *
 * Strategy: chunk by week_end_date. Each weekly slice is ~2.7M rows.
 * Filter clause uses (week_end_date = X) which the PK
 * (week_end_date, search_term_id) covers via index range scan. Re-runnable
 * — only updates rows where severity is still NULL.
 *
 * Connection: uses pg.Pool (TCP keepalive) instead of @neondatabase/
 * serverless HTTP because each per-week UPDATE can take 30-60s — well
 * past the HTTP driver's request timeout.
 *
 * Estimated total: 25-55 minutes across all 53 weeks.
 *
 * Usage: pnpm tsx scripts/backfillFakeVolumeSeverity.ts
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
    // 1. Get the list of weeks with imported data
    const { rows: weekRows } = await client.query<{ week_end_date: string }>(
      `SELECT week_end_date FROM reporting_weeks ORDER BY week_end_date`,
    );
    console.log(`Found ${weekRows.length} weeks to process`);

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
