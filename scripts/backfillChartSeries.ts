/**
 * One-time backfill that builds a keyword_chart_series row for every ACTIVE
 * search term from keyword_weekly_metrics (kwm).
 *
 * ACTIVE = present in keyword_current_summary (kcs), which holds only active terms.
 *
 * Window: each term's kwm rows within the 52-calendar-week window ending at
 * current_week (week_end_date >= current_week::date - INTERVAL '357 days').
 * This matches exactly what buildWeekCalendar(current_week, 52) plots, so the
 * stored series produces identical charts to the live kwm read.
 *
 * STRATEGY — single sequential pass via a server-side cursor.
 *   A SELECT … ORDER BY (search_term_id, week_end_date) over the window lets
 *   Postgres do ONE sequential scan + sort instead of millions of per-term
 *   random index reads (the per-term approach was warm-fast on a small sample
 *   but the full ~100GB window doesn't fit cache → cold random reads at scale).
 *   We DECLARE a cursor and FETCH in chunks, grouping rows into one series per
 *   term as the id changes — reusing the shared kwmRowToEntry/appendWeek so the
 *   backfilled entries are byte-identical to what the refresh maintenance builds.
 *
 *   - Reads run in a long read-only transaction on `cursorClient`.
 *   - Writes go through a SEPARATE autocommit connection (`writeClient`) so
 *     partial progress persists even if the process dies, and the read cursor
 *     stays read-only.
 *   - statement_timeout is disabled on the cursor connection: the first FETCH
 *     materializes the full sort, which can take several minutes.
 *
 * Upsert: INSERT … ON CONFLICT DO UPDATE in batches, with a short sleep between
 * write batches to avoid starving live readers (idempotent — safe to re-run).
 *
 * Flags:
 *   --dry-run        Read + build + sort, but perform NO writes (gauge/verify).
 *   --limit-terms N  Stop after N completed terms (early-closes the cursor).
 *
 * Usage:
 *   pnpm tsx scripts/backfillChartSeries.ts --dry-run --limit-terms 200
 *   pnpm tsx scripts/backfillChartSeries.ts                 # full run (table must exist)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool, type PoolClient } from 'pg';
import { kwmRowToEntry, appendWeek, type ChartSeriesKwmRow } from '@/lib/explorer/chartSeries';
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Rows pulled per FETCH from the server-side cursor. */
const FETCH_CHUNK = 20_000;

/** Completed terms accumulated before a single upsert batch. */
const UPSERT_BATCH_SIZE = 1_000;

/** Milliseconds to sleep between write batches (throttle). */
const SLEEP_MS = 40;

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

// Row shape the cursor returns (search_term_id cast to text for stable JS compares).
type CursorRow = ChartSeriesKwmRow & { search_term_id: string };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { dryRun, limitTerms } = parseArgs();

  console.log('=== backfillChartSeries (sequential cursor) ===');
  console.log(`  dry-run     : ${dryRun}`);
  console.log(`  limit-terms : ${limitTerms ?? '(none)'}`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });

  const cursorClient = await pool.connect();
  const writeClient = await pool.connect();

  let cursorOpen = false;
  try {
    // The first FETCH materializes a large sort — disable the per-statement
    // timeout on the cursor connection.
    await cursorClient.query('SET statement_timeout = 0');

    // 1. Current week + window lower bound.
    const metaRes = await cursorClient.query<{ current_week_end_date: string }>(
      `SELECT current_week_end_date::text AS current_week_end_date
       FROM keyword_current_summary_meta WHERE singleton = true`,
    );
    if (metaRes.rows.length === 0) {
      console.error('keyword_current_summary_meta is empty — cannot determine current week.');
      process.exit(1);
    }
    const currentWeek = metaRes.rows[0].current_week_end_date.slice(0, 10);
    console.log(`  current_week: ${currentWeek}`);

    const cntRes = await cursorClient.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM keyword_current_summary`,
    );
    const totalActive = parseInt(cntRes.rows[0].n, 10);
    console.log(`  active terms: ${totalActive.toLocaleString()}`);
    console.log('');

    // 2. Open the cursor over the ordered window.
    //    windowStart is a SQL literal built from the trusted meta value.
    const windowStart = `(DATE '${currentWeek}' - INTERVAL '357 days')`;
    await cursorClient.query('BEGIN');
    await cursorClient.query(`
      DECLARE chart_cur NO SCROLL CURSOR FOR
      SELECT
        k.search_term_id::text AS search_term_id,
        k.week_end_date,
        k.actual_rank,
        k.fake_volume_severity,
        k.fake_volume_eval_status,
        k.top_clicked_product_1_click_share,
        k.top_clicked_product_1_conversion_share,
        k.keyword_in_title_1,
        k.keyword_in_title_2,
        k.keyword_in_title_3,
        k.keyword_in_title_1_loose,
        k.keyword_in_title_2_loose,
        k.keyword_in_title_3_loose
      FROM keyword_weekly_metrics k
      JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id
      WHERE k.week_end_date >= ${windowStart}
      ORDER BY k.search_term_id, k.week_end_date ASC
    `);
    cursorOpen = true;
    console.log('  sorting window — the first FETCH may take several minutes...');

    // 3. Stream-group rows into one series per term.
    let currentTermId: string | null = null;
    let currentSeries: ChartSeriesEntry[] = [];
    let termsProcessed = 0;
    let upsertPending: Array<{ id: string; series: ChartSeriesEntry[]; lastWeek: string }> = [];
    let sampleLogged = false;
    let limitReached = false;
    const startedAt = Date.now();

    const completeTerm = () => {
      if (currentTermId === null || currentSeries.length === 0) return;
      if (dryRun && !sampleLogged) {
        console.log('--- DRY-RUN SAMPLE (first completed term) ---');
        console.log(`  search_term_id : ${currentTermId}`);
        console.log(`  entries        : ${currentSeries.length}`);
        console.log(`  first entry    : ${JSON.stringify(currentSeries[0])}`);
        console.log(`  last entry     : ${JSON.stringify(currentSeries[currentSeries.length - 1])}`);
        console.log('');
        sampleLogged = true;
      }
      if (!dryRun) {
        upsertPending.push({
          id: currentTermId,
          series: currentSeries,
          lastWeek: currentSeries[currentSeries.length - 1].w,
        });
      }
      termsProcessed++;
      if (limitTerms !== null && termsProcessed >= limitTerms) limitReached = true;
    };

    while (!limitReached) {
      const res = await cursorClient.query<CursorRow>(`FETCH ${FETCH_CHUNK} FROM chart_cur`);
      if (res.rows.length === 0) break; // cursor exhausted

      for (const row of res.rows) {
        if (row.search_term_id !== currentTermId) {
          completeTerm(); // previous term is fully read
          if (limitReached) break;
          currentTermId = row.search_term_id;
          currentSeries = [];
        }
        currentSeries = appendWeek(currentSeries, kwmRowToEntry(row), 52);
      }
      if (limitReached) break;

      if (!dryRun && upsertPending.length >= UPSERT_BATCH_SIZE) {
        await flushUpsert(writeClient, upsertPending);
        upsertPending = [];
        await sleep(SLEEP_MS);
      }

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(
        `\r  processed ${termsProcessed.toLocaleString().padStart(9)} / ${totalActive.toLocaleString()} terms  (${elapsed}s)`,
      );
    }

    // Flush the final in-progress term only when the cursor ended naturally
    // (on an early --limit-terms stop the in-progress term is intentionally dropped).
    if (!limitReached) completeTerm();
    else console.log(`\n  --limit-terms ${limitTerms} reached — stopping.`);

    if (!dryRun && upsertPending.length > 0) {
      await flushUpsert(writeClient, upsertPending);
    }

    await cursorClient.query('CLOSE chart_cur');
    cursorOpen = false;
    await cursorClient.query('COMMIT');

    console.log('');
    console.log('');
    console.log('=== Summary ===');
    console.log(`  Terms processed  : ${termsProcessed.toLocaleString()}`);
    console.log(`  Writes performed : ${dryRun ? '0 (dry-run)' : termsProcessed.toLocaleString()}`);
    console.log(`  Elapsed          : ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    if (dryRun) console.log('\nDRY-RUN complete — no rows written to keyword_chart_series.');
  } catch (e) {
    if (cursorOpen) await cursorClient.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cursorClient.release();
    writeClient.release();
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

  // Multi-row VALUES for a single INSERT … ON CONFLICT DO UPDATE. Each term
  // contributes 3 params (id, series_json, last_week); updated_at is omitted
  // so it DEFAULTs to now() on insert and is set explicitly on update.
  const values: unknown[] = [];
  const rowFragments: string[] = [];
  for (let i = 0; i < batch.length; i++) {
    const base = i * 3;
    values.push(batch[i].id, JSON.stringify(batch[i].series), batch[i].lastWeek);
    rowFragments.push(`($${base + 1}::uuid, $${base + 2}::jsonb, $${base + 3}::date)`);
  }

  const sql = `
    INSERT INTO keyword_chart_series (search_term_id, series, last_week)
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
