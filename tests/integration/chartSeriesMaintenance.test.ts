/**
 * Integration test for maintainChartSeries.
 *
 * Gated by RUN_INTEGRATION=1 (same as all integration tests). Requires a
 * test database with the full schema applied (including migration 0036 which
 * adds keyword_chart_series).
 *
 * Run: RUN_INTEGRATION=1 pnpm test:integration tests/integration/chartSeriesMaintenance.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import 'dotenv/config';

import { maintainChartSeries } from '@/inngest/functions/refreshSummary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekMinus(baseIso: string, weeks: number): string {
  const d = new Date(baseIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - weeks * 7);
  return isoDate(d);
}

/** Build a minimal ChartSeriesEntry object as JSON for seeding. */
function makeEntry(weekIso: string, rank = 5000): Record<string, unknown> {
  return {
    w: weekIso,
    r: rank,
    sev: null,
    es: null,
    cs: null,
    vs: null,
    t: [null, null, null],
    tl: [null, null, null],
  };
}

/** A minimal kcs row for keyword_current_summary seeding. */
function makeKcsRow(
  searchTermId: string,
  weekIso: string,
  rank = 5000,
): Record<string, unknown> {
  return {
    search_term_id: searchTermId,
    current_week_end_date: weekIso,
    current_rank: rank,
    consecutive_improvement_streak: 0,
    ever_top_50k: false,
    has_unranked_week: false,
    unranked_week_count: 0,
    unranked_after_top_50k: false,
    last_seen_week: weekIso,
    weeks_since_seen: 0,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('maintainChartSeries (integration)', () => {
  // currentWeek is resolved dynamically from the production DB in beforeAll.
  // Using the actual production current week means production rows in
  // keyword_current_summary are already "at current week" — so the rebuild
  // phase in maintainChartSeries only touches our 4 test seeds, not the
  // millions of production rows.
  let CURRENT_WEEK: string;
  let PREV_WEEK: string;

  let pool: Pool;
  // UUIDs for the 4 test search_terms we'll insert
  const termIds: string[] = [];
  // Dummy upload objects needed to satisfy kwm.source_file_id FK
  let dummyFileId: string;
  let dummyBatchId: string;
  let dummyUserId: string;

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return;

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
      // Ensure keyword_chart_series exists (migration 0036 may not be applied
      // in the test DB yet — create it idempotently so the test can run).
      await client.query(`
        CREATE TABLE IF NOT EXISTS keyword_chart_series (
          search_term_id uuid        PRIMARY KEY REFERENCES search_terms(id) ON DELETE CASCADE,
          series         jsonb       NOT NULL,
          last_week      date        NOT NULL,
          updated_at     timestamptz NOT NULL DEFAULT now()
        )
      `);

      // Resolve the actual production current week so our test terms are
      // inserted at the same week — this prevents the rebuild SELECT from
      // picking up millions of production kcs rows as "behind".
      const { rows: weekRows } = await client.query<{ w: string }>(
        `SELECT MAX(current_week_end_date)::text AS w FROM keyword_current_summary`,
      );
      CURRENT_WEEK = weekRows[0]?.w ?? isoDate(new Date());
      PREV_WEEK = weekMinus(CURRENT_WEEK, 1);

      await client.query('BEGIN');

      // Create a dummy user + batch + uploaded_file for use as kwm source_file_id.
      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO users (clerk_user_id, email)
         VALUES ('csmtest_user_' || extract(epoch from now())::bigint, 'csmtest_' || extract(epoch from now())::bigint || '@test.invalid')
         RETURNING id`,
      );
      dummyUserId = userRows[0].id;

      const { rows: batchRows } = await client.query<{ id: string }>(
        `INSERT INTO upload_batches (batch_type, status, total_files, created_by_user_id)
         VALUES ('single_csv', 'uploaded', 1, $1)
         RETURNING id`,
        [dummyUserId],
      );
      dummyBatchId = batchRows[0].id;

      const { rows: fileRows } = await client.query<{ id: string }>(
        `INSERT INTO uploaded_files (batch_id, storage_key, original_filename, validation_status)
         VALUES ($1, 'csmtest/fake.csv', 'csmtest_fake.csv', 'pending')
         RETURNING id`,
        [dummyBatchId],
      );
      dummyFileId = fileRows[0].id;

      // Allocate 4 fresh search_term_id UUIDs. Include all NOT NULL columns.
      const { rows: termRows } = await client.query<{ id: string }>(
        `INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
         SELECT 'csmtest_' || gs::text,
                lower('csmtest_' || gs::text),
                $1::date,
                $1::date
         FROM generate_series(1, 4) gs
         RETURNING id`,
        [CURRENT_WEEK],
      );
      for (const r of termRows) termIds.push(r.id);

      // Insert keyword_current_summary rows for all 4 terms at CURRENT_WEEK.
      // (keyword_current_summary_stage is the real staging table but for the
      //  test we insert directly into keyword_current_summary.)
      const kcsValues = termIds.map((id, i) => makeKcsRow(id, CURRENT_WEEK, 5000 + i * 100));
      for (const row of kcsValues) {
        await client.query(
          `INSERT INTO keyword_current_summary (
             search_term_id, current_week_end_date, current_rank,
             consecutive_improvement_streak, ever_top_50k,
             has_unranked_week, unranked_week_count, unranked_after_top_50k,
             last_seen_week, weeks_since_seen
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (search_term_id) DO UPDATE
             SET current_week_end_date = EXCLUDED.current_week_end_date,
                 current_rank = EXCLUDED.current_rank`,
          [
            row.search_term_id,
            row.current_week_end_date,
            row.current_rank,
            row.consecutive_improvement_streak,
            row.ever_top_50k,
            row.has_unranked_week,
            row.unranked_week_count,
            row.unranked_after_top_50k,
            row.last_seen_week,
            row.weeks_since_seen,
          ],
        );
      }

      // term[0]: series with last_week = PREV_WEEK (the normal "append" case).
      await client.query(
        `INSERT INTO keyword_chart_series (search_term_id, series, last_week, updated_at)
         VALUES ($1, $2::jsonb, $3::date, now())
         ON CONFLICT (search_term_id) DO UPDATE
           SET series = EXCLUDED.series, last_week = EXCLUDED.last_week`,
        [
          termIds[0],
          JSON.stringify([makeEntry(weekMinus(CURRENT_WEEK, 2)), makeEntry(PREV_WEEK)]),
          PREV_WEEK,
        ],
      );

      // term[1]: series at 52 entries with last_week = PREV_WEEK (cap test).
      const fullSeries = Array.from({ length: 52 }, (_, i) =>
        makeEntry(weekMinus(CURRENT_WEEK, 52 - i)),
      );
      await client.query(
        `INSERT INTO keyword_chart_series (search_term_id, series, last_week, updated_at)
         VALUES ($1, $2::jsonb, $3::date, now())
         ON CONFLICT (search_term_id) DO UPDATE
           SET series = EXCLUDED.series, last_week = EXCLUDED.last_week`,
        [termIds[1], JSON.stringify(fullSeries), PREV_WEEK],
      );

      // term[2]: series already at CURRENT_WEEK (idempotency / replace test).
      await client.query(
        `INSERT INTO keyword_chart_series (search_term_id, series, last_week, updated_at)
         VALUES ($1, $2::jsonb, $3::date, now())
         ON CONFLICT (search_term_id) DO UPDATE
           SET series = EXCLUDED.series, last_week = EXCLUDED.last_week`,
        [
          termIds[2],
          JSON.stringify([makeEntry(PREV_WEEK), makeEntry(CURRENT_WEEK, 99999)]),
          CURRENT_WEEK,
        ],
      );

      // term[3]: NO series row → rebuild path.
      // (No INSERT for term[3]; it gets picked up via the LEFT JOIN gap.)
      // We need a kwm row so the rebuild query can build a series.
      await client.query(
        `INSERT INTO keyword_weekly_metrics (
           search_term_id, week_end_date, actual_rank,
           keyword_in_title_1, keyword_in_title_2, keyword_in_title_3,
           keyword_in_title_1_loose, keyword_in_title_2_loose, keyword_in_title_3_loose,
           source_file_id
         ) VALUES ($1, $2::date, $3, false, false, false, false, false, false, $4)
         ON CONFLICT DO NOTHING`,
        [termIds[3], CURRENT_WEEK, 7500, dummyFileId],
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Run maintainChartSeries ONCE here (after seeding) so individual tests
    // are just assertions. A single production-scale run is acceptable;
    // re-running it in each test would compound the latency.
    const maintainClient = await pool.connect();
    try {
      await maintainChartSeries(maintainClient, CURRENT_WEEK);
    } finally {
      maintainClient.release();
    }
  }, 300_000 /* 5-minute timeout for production-scale DB maintenance */);

  afterAll(async () => {
    if (!pool) return;
    const client = await pool.connect();
    try {
      // Clean up all test data in FK-safe order.
      await client.query(
        `DELETE FROM keyword_chart_series WHERE search_term_id = ANY($1::uuid[])`,
        [termIds],
      );
      await client.query(
        `DELETE FROM keyword_current_summary WHERE search_term_id = ANY($1::uuid[])`,
        [termIds],
      );
      await client.query(
        `DELETE FROM keyword_weekly_metrics WHERE search_term_id = ANY($1::uuid[])`,
        [termIds],
      );
      await client.query(
        `DELETE FROM search_terms WHERE id = ANY($1::uuid[])`,
        [termIds],
      );
      // Clean up dummy upload scaffold used for kwm FK
      if (dummyFileId) {
        await client.query(`DELETE FROM uploaded_files WHERE id = $1`, [dummyFileId]);
      }
      if (dummyBatchId) {
        await client.query(`DELETE FROM upload_batches WHERE id = $1`, [dummyBatchId]);
      }
      if (dummyUserId) {
        await client.query(`DELETE FROM users WHERE id = $1`, [dummyUserId]);
      }
    } finally {
      client.release();
      await pool.end();
    }
  });

  // Helper: run maintainChartSeries and return its client internally
  async function runMaintain(): Promise<void> {
    const client = await pool.connect();
    try {
      await maintainChartSeries(client, CURRENT_WEEK);
    } finally {
      client.release();
    }
  }

  async function fetchSeriesRow(
    termId: string,
  ): Promise<{ series: unknown[]; last_week: string } | null> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ series: unknown[]; last_week: string }>(
        `SELECT series, last_week::text FROM keyword_chart_series WHERE search_term_id = $1`,
        [termId],
      );
      return rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  it('(a) appends new week and advances last_week for a contiguous term', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    // maintainChartSeries was called in beforeAll — just assert the result.
    const row = await fetchSeriesRow(termIds[0]);
    expect(row).not.toBeNull();
    expect(row!.last_week).toBe(CURRENT_WEEK);
    expect(Array.isArray(row!.series)).toBe(true);
    const series = row!.series as Array<{ w: string }>;
    const lastEntry = series[series.length - 1];
    expect(lastEntry.w).toBe(CURRENT_WEEK);
  });

  it('(b) length never exceeds 52 (oldest dropped)', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    const row = await fetchSeriesRow(termIds[1]);
    expect(row).not.toBeNull();
    const series = row!.series as Array<{ w: string }>;
    expect(series.length).toBe(52);
    const lastEntry = series[series.length - 1];
    expect(lastEntry.w).toBe(CURRENT_WEEK);
  });

  it(
    '(c) re-running is idempotent — already-current term has last entry replaced, not duplicated',
    async () => {
      if (!process.env.RUN_INTEGRATION) {
        console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
        return;
      }

      // Run again to verify idempotency (second call after beforeAll's first call).
      await runMaintain();

      const row = await fetchSeriesRow(termIds[2]);
      expect(row).not.toBeNull();
      const series = row!.series as Array<{ w: string }>;
      // Should still be 2 entries, not 3
      expect(series.length).toBe(2);
      const lastEntry = series[series.length - 1];
      expect(lastEntry.w).toBe(CURRENT_WEEK);
      // The last entry should now reflect the kcs rank (5200 for termIds[2]),
      // not the stale seed value of 99999
      const lastR = (lastEntry as { w: string; r: number }).r;
      expect(lastR).toBe(5200);
    },
    300_000,
  );

  it('(d) a term with no series row gets one built (rebuild path)', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    const row = await fetchSeriesRow(termIds[3]);
    expect(row).not.toBeNull();
    expect(row!.last_week).toBe(CURRENT_WEEK);
    const series = row!.series as Array<{ w: string; r: number }>;
    expect(series.length).toBeGreaterThan(0);
    const lastEntry = series[series.length - 1];
    expect(lastEntry.w).toBe(CURRENT_WEEK);
    expect(lastEntry.r).toBe(7500);
  });
});
