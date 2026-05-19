/**
 * Snapshot of Keepa enrichment progress for a given week.
 *
 * Reads asin_weekly_data for the given week and reports:
 *   - Status histogram (active / no_price / delisted / error)
 *   - Earliest and most-recent insert timestamps (gives wall-clock pace)
 *   - Remaining in-scope ASINs (re-runs the listScope candidate query)
 *   - Sample of any recent error rows
 *   - Activity signal (seconds since the last insert — flags stalled runs)
 *
 * Use during long-running backfills to verify progress without opening
 * the Inngest dashboard, or as a quick sanity check after a weekly
 * auto-fired enrichment.
 *
 * Usage:
 *   pnpm tsx scripts/checkKeepaProgress.ts                 # current kcs week
 *   pnpm tsx scripts/checkKeepaProgress.ts 2026-05-02      # explicit week
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function resolveWeek(client: import('pg').PoolClient, argWeek: string | undefined): Promise<string> {
  if (argWeek) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(argWeek)) {
      throw new Error(`Invalid week format "${argWeek}". Use YYYY-MM-DD.`);
    }
    return argWeek;
  }
  const { rows } = await client.query<{ current_week: string }>(`
    SELECT current_week_end_date::text AS current_week
    FROM keyword_current_summary_meta WHERE singleton = true
  `);
  if (rows.length === 0) throw new Error('keyword_current_summary_meta has no singleton row');
  return rows[0].current_week;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const c = await pool.connect();
  try {
    const week = await resolveWeek(c, process.argv[2]);
    const partition = `keyword_weekly_metrics_${week.slice(0, 4)}`;
    // Status histogram + total
    const { rows: hist } = await c.query<{ status: string; n: number }>(
      `SELECT enrichment_status::text AS status, COUNT(*)::int AS n
       FROM asin_weekly_data
       WHERE week_end_date = $1::date
       GROUP BY 1 ORDER BY 1`,
      [week],
    );
    const total = hist.reduce((s, r) => s + r.n, 0);

    // Most-recent + earliest insert (gives us pace)
    const { rows: range } = await c.query<{
      earliest_iso: string | null;
      latest_iso: string | null;
      span_min: number | null;
      seconds_since_last: number | null;
    }>(
      `SELECT
         MIN(enriched_at)::text AS earliest_iso,
         MAX(enriched_at)::text AS latest_iso,
         EXTRACT(EPOCH FROM (MAX(enriched_at) - MIN(enriched_at)))::int / 60 AS span_min,
         EXTRACT(EPOCH FROM (NOW() - MAX(enriched_at)))::int AS seconds_since_last
       FROM asin_weekly_data
       WHERE week_end_date = $1::date`,
      [week],
    );

    // How many remain? Re-run a simplified listScope (rank ≤ 100K only;
    // we skip the category-exclusion clause here since it'd require
    // importing lib/keepa and the count is for display only).
    const { rows: scope } = await c.query<{ remaining: number }>(
      `
      WITH new_candidates AS (
        SELECT t.asin
        FROM ${partition} kwm
        CROSS JOIN LATERAL (VALUES
          (kwm.top_clicked_product_1_asin),
          (kwm.top_clicked_product_2_asin),
          (kwm.top_clicked_product_3_asin)
        ) AS t(asin)
        WHERE kwm.week_end_date = $1::date
          AND kwm.actual_rank <= 100000
          AND t.asin IS NOT NULL
      )
      SELECT COUNT(DISTINCT c.asin)::int AS remaining
      FROM new_candidates c
      WHERE NOT EXISTS (
        SELECT 1 FROM asin_weekly_data a
        WHERE a.asin = c.asin AND a.week_end_date = $1::date
      )
      `,
      [week],
    );
    const remaining = scope[0]?.remaining ?? 0;

    // Sample some recent failures for diagnostics
    const { rows: sampleErrors } = await c.query<{
      asin: string; error_message: string; enriched_at: string;
    }>(`
      SELECT asin, error_message, enriched_at::text
      FROM asin_weekly_data
      WHERE week_end_date = $1::date AND enrichment_status = 'error'
      ORDER BY enriched_at DESC LIMIT 5
    `, [week]);

    console.log(`\n=== Keepa backfill progress for week ${week} ===\n`);
    console.log(`Status histogram:`);
    for (const r of hist) {
      const pct = ((r.n / total) * 100).toFixed(2);
      console.log(`  ${r.status.padEnd(10)} ${r.n.toLocaleString().padStart(8)}  (${pct}%)`);
    }
    console.log(`  ${'TOTAL'.padEnd(10)} ${total.toLocaleString().padStart(8)}`);

    console.log(`\nTime span:`);
    console.log(`  First insert:           ${range[0].earliest_iso}`);
    console.log(`  Last insert:            ${range[0].latest_iso}`);
    console.log(`  Total span (minutes):   ${range[0].span_min}`);
    console.log(`  Seconds since last:     ${range[0].seconds_since_last}`);

    if (range[0].span_min && total > 50) {
      // exclude the smoke-test seed when computing pace
      const enrichedSinceStart = total - 50;
      const pacePerMin = (enrichedSinceStart / range[0].span_min);
      const minutesRemaining = remaining / pacePerMin;
      console.log(`\nPace (excluding 50 smoke-test rows):`);
      console.log(`  ASINs / min:            ${pacePerMin.toFixed(1)}`);
      console.log(`  ETA on remaining ${remaining.toLocaleString()}:  ${Math.round(minutesRemaining / 60)}h ${Math.round(minutesRemaining % 60)}m`);
    }

    console.log(`\nRemaining in-scope (rank ≤ 100K, NOT yet enriched): ${remaining.toLocaleString()}`);

    if (sampleErrors.length > 0) {
      console.log(`\nMost recent ${sampleErrors.length} error rows:`);
      for (const e of sampleErrors) {
        console.log(`  ${e.asin}  ${e.enriched_at.slice(0, 19)}  ${e.error_message?.slice(0, 80)}`);
      }
    } else {
      console.log(`\nNo error rows. 👍`);
    }

    // Sanity: is anything still inserting?
    if (range[0].seconds_since_last !== null) {
      if (range[0].seconds_since_last < 30) {
        console.log(`\n✓ Active: insert within last ${range[0].seconds_since_last}s`);
      } else if (range[0].seconds_since_last < 300) {
        console.log(`\n⚠ Last insert was ${range[0].seconds_since_last}s ago — between batches, or pacer pause.`);
      } else if (remaining > 0) {
        console.log(`\n🚨 Last insert was ${range[0].seconds_since_last}s ago (${Math.round(range[0].seconds_since_last / 60)}min) — but ${remaining.toLocaleString()} ASINs remain. Function may be stalled.`);
      } else {
        console.log(`\n✓ All done — last insert ${range[0].seconds_since_last}s ago, 0 remaining.`);
      }
    }
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
