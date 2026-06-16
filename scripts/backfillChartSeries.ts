/**
 * One-time backfill that builds a keyword_chart_series row for every ACTIVE
 * search term from keyword_weekly_metrics (kwm).
 *
 * ACTIVE = present in keyword_current_summary (kcs), which holds only active terms.
 *
 * Window: each term's kwm rows within the 52-calendar-week window ending at
 * current_week (i.e. week_end_date >= current_week::date - INTERVAL '357 days').
 * This matches exactly what buildWeekCalendar(current_week, 52) plots, so the
 * stored series produces identical charts to the live kwm read.
 *
 * Streaming: no pg-cursor or pg-query-stream in this project, so we use keyset
 * pagination: fetch BATCH_SIZE terms at a time ordered by search_term_id, then
 * for each batch pull all of their windowed kwm rows in one query ordered by
 * (search_term_id, week_end_date). No server-side cursor, but keeps memory
 * bounded and never loads more than BATCH_SIZE terms' data at once.
 *
 * Upsert: INSERT … ON CONFLICT DO UPDATE in batches of UPSERT_BATCH terms.
 * A short sleep between write batches avoids starving live readers.
 *
 * Flags:
 *   --dry-run        Skip all DB writes; log a sample built series.
 *   --limit-terms N  Stop after N completed terms.
 *
 * Usage:
 *   pnpm tsx scripts/backfillChartSeries.ts --dry-run --limit-terms 50
 *   pnpm tsx scripts/backfillChartSeries.ts                   # real run (table must exist)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool, type PoolClient } from 'pg';
import { kwmRowToEntry, appendWeek, type ChartSeriesKwmRow } from '@/lib/explorer/chartSeries';
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How many distinct search_term_ids to fetch from kcs per keyset page. */
const TERM_BATCH_SIZE = 500;

/** How many completed terms to accumulate before a single upsert batch. */
const UPSERT_BATCH_SIZE = 500;

/** Milliseconds to sleep between write batches (throttle). */
const SLEEP_MS = 75;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(): { dryRun: boolean; limitTerms: number | null } {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit-terms');
  const limitTerms = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  return { dryRun, limitTerms };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { dryRun, limitTerms } = parseArgs();

  console.log('=== backfillChartSeries ===');
  console.log(`  dry-run     : ${dryRun}`);
  console.log(`  limit-terms : ${limitTerms ?? '(none)'}`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    // Long timeout for large kwm page reads; write batches are small.
    statement_timeout: 120_000,
  });

  const client = await pool.connect();

  try {
    // -----------------------------------------------------------------------
    // 1. Current week
    // -----------------------------------------------------------------------
    const metaRes = await client.query<{ current_week_end_date: string }>(
      `SELECT current_week_end_date::text AS current_week_end_date
       FROM keyword_current_summary_meta WHERE singleton = true`,
    );
    if (metaRes.rows.length === 0) {
      console.error('keyword_current_summary_meta is empty — cannot determine current week.');
      process.exit(1);
    }
    const currentWeek = metaRes.rows[0].current_week_end_date.slice(0, 10);
    console.log(`  current_week: ${currentWeek}`);

    // Window lower bound: 52 calendar weeks = 357 days before current_week.
    // We pass this as a string to avoid any timezone confusion.
    const windowStart = `(DATE '${currentWeek}' - INTERVAL '357 days')`;

    // -----------------------------------------------------------------------
    // 2. Total active-term count (for progress display)
    // -----------------------------------------------------------------------
    const cntRes = await client.query<{ n: string }>(
      `SELECT COUNT(DISTINCT search_term_id)::text AS n FROM keyword_current_summary`,
    );
    const totalActive = parseInt(cntRes.rows[0].n, 10);
    console.log(`  active terms: ${totalActive.toLocaleString()}`);
    console.log('');

    // -----------------------------------------------------------------------
    // 3. Keyset-paginate through all active search_term_ids
    // -----------------------------------------------------------------------
    let lastId: string | null = null;   // keyset cursor (UUID string)
    let termsProcessed = 0;
    let upsertPending: Array<{ id: string; series: ChartSeriesEntry[]; lastWeek: string }> = [];

    // For dry-run reporting
    let sampleLogged = false;
    const startedAt = Date.now();

    outer: while (true) {
      // --- Fetch next page of active term IDs ---
      let termPageRows: Array<{ search_term_id: string }>;
      if (lastId !== null) {
        const res = await client.query<{ search_term_id: string }>(
          `SELECT DISTINCT search_term_id
           FROM keyword_current_summary
           WHERE search_term_id > $1
           ORDER BY search_term_id
           LIMIT ${TERM_BATCH_SIZE}`,
          [lastId],
        );
        termPageRows = res.rows;
      } else {
        const res = await client.query<{ search_term_id: string }>(
          `SELECT DISTINCT search_term_id
           FROM keyword_current_summary
           ORDER BY search_term_id
           LIMIT ${TERM_BATCH_SIZE}`,
        );
        termPageRows = res.rows;
      }

      if (termPageRows.length === 0) break; // all pages done

      const pageIds: string[] = termPageRows.map((r) => r.search_term_id);
      lastId = pageIds[pageIds.length - 1];

      // --- Fetch kwm rows for this page of terms ---
      // Rows come back ordered by (search_term_id, week_end_date ASC) which
      // lets us process one term at a time without sorting in JS.
      const kwmRes2 = await client.query<ChartSeriesKwmRow & { search_term_id: string }>(
        `SELECT
           kwm.search_term_id,
           kwm.week_end_date,
           kwm.actual_rank,
           kwm.fake_volume_severity,
           kwm.fake_volume_eval_status,
           kwm.top_clicked_product_1_click_share,
           kwm.top_clicked_product_1_conversion_share,
           kwm.keyword_in_title_1,
           kwm.keyword_in_title_2,
           kwm.keyword_in_title_3,
           kwm.keyword_in_title_1_loose,
           kwm.keyword_in_title_2_loose,
           kwm.keyword_in_title_3_loose
         FROM keyword_weekly_metrics kwm
         WHERE kwm.search_term_id = ANY($1::uuid[])
           AND kwm.week_end_date >= ${windowStart}
         ORDER BY kwm.search_term_id, kwm.week_end_date ASC`,
        [pageIds],
      );

      // --- Build series per term ---
      let currentTermId: string | null = null;
      let currentSeries: ChartSeriesEntry[] = [];

      const flushTerm = (termId: string, series: ChartSeriesEntry[]) => {
        if (series.length === 0) return; // no kwm data for this term in window → skip
        const lastWeek = series[series.length - 1].w;

        // Dry-run sample: log first completed term
        if (dryRun && !sampleLogged) {
          console.log('--- DRY-RUN SAMPLE (first completed term) ---');
          console.log(`  search_term_id : ${termId}`);
          console.log(`  entries        : ${series.length}`);
          console.log(`  first entry    : ${JSON.stringify(series[0])}`);
          console.log(`  last entry     : ${JSON.stringify(series[series.length - 1])}`);
          console.log('');
          sampleLogged = true;
        }

        upsertPending.push({ id: termId, series, lastWeek });
        termsProcessed++;
      };

      for (const row of kwmRes2.rows) {
        if (row.search_term_id !== currentTermId) {
          // New term: flush previous
          if (currentTermId !== null) {
            flushTerm(currentTermId, currentSeries);
            if (limitTerms !== null && termsProcessed >= limitTerms) break;
          }
          currentTermId = row.search_term_id;
          currentSeries = [];
        }
        const entry = kwmRowToEntry(row);
        currentSeries = appendWeek(currentSeries, entry, 52);
      }
      // Flush last term in this page
      if (currentTermId !== null) {
        flushTerm(currentTermId, currentSeries);
      }

      // Check limit
      if (limitTerms !== null && termsProcessed >= limitTerms) {
        console.log(`  --limit-terms ${limitTerms} reached — stopping.`);
        break outer;
      }

      // --- Upsert when we've accumulated enough ---
      if (!dryRun && upsertPending.length >= UPSERT_BATCH_SIZE) {
        await flushUpsert(client, upsertPending);
        upsertPending = [];
        await sleep(SLEEP_MS);
      }

      // Progress
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(
        `\r  processed ${termsProcessed.toLocaleString().padStart(7)} / ${totalActive.toLocaleString()} terms  (${elapsed}s)`,
      );
    }

    // Final upsert of remaining
    if (!dryRun && upsertPending.length > 0) {
      await flushUpsert(client, upsertPending);
      await sleep(SLEEP_MS);
    }

    console.log('');
    console.log('');
    console.log('=== Summary ===');
    console.log(`  Terms processed  : ${termsProcessed.toLocaleString()}`);
    console.log(`  Writes performed : ${dryRun ? '0 (dry-run)' : termsProcessed.toLocaleString()}`);
    console.log(`  Elapsed          : ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    if (dryRun) {
      console.log('');
      console.log('DRY-RUN complete — no rows written to keyword_chart_series.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Upsert helper
// ---------------------------------------------------------------------------

async function flushUpsert(
  client: PoolClient,
  batch: Array<{ id: string; series: ChartSeriesEntry[]; lastWeek: string }>,
): Promise<void> {
  if (batch.length === 0) return;

  // Build multi-row VALUES for a single INSERT … ON CONFLICT DO UPDATE.
  // Each term contributes 3 params: (search_term_id, series_json, last_week).
  const values: unknown[] = [];
  const rowFragments: string[] = [];

  for (let i = 0; i < batch.length; i++) {
    const base = i * 3;
    values.push(batch[i].id, JSON.stringify(batch[i].series), batch[i].lastWeek);
    rowFragments.push(`($${base + 1}::uuid, $${base + 2}::jsonb, $${base + 3}::date)`);
  }

  const sql = `
    INSERT INTO keyword_chart_series (search_term_id, series, last_week, updated_at)
    VALUES ${rowFragments.join(', ')}
    ON CONFLICT (search_term_id) DO UPDATE
      SET series     = EXCLUDED.series,
          last_week  = EXCLUDED.last_week,
          updated_at = now()
  `;

  await client.query(sql, values);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
