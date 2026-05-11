/**
 * Backfill keyword_in_title_*_loose + keyword_title_match_count_loose
 * across kwm. Uses migration 0016's padded-string matcher.
 *
 * Per-week strategy (one UPDATE per week, single pass):
 *   - Target the yearly child partition by name (avoid parent dispatch
 *     and the ctid cross-partition collision that the previous
 *     materialized-CTE approach hit).
 *   - One direct UPDATE ... FROM search_terms that calls
 *     loose_title_flags_3 once per row, producing all 4 loose values
 *     in one composite. No temp tables, no MATERIALIZED CTE.
 *   - Resume marker: keyword_title_match_count_loose IS NULL.
 *
 * Optional environment variables:
 *   WEEK_FILTER=YYYY-MM-DD   Process only this week (used by the
 *                            single-week trial).
 *   WEEK_RANGE=N             Process only the most recent N weeks
 *                            (used by the "trailing quarter" backfill).
 *   WEEK_RANGE and WEEK_FILTER are mutually exclusive.
 *
 * Connection: pg.Pool (TCP). neon-http times out on multi-min UPDATEs.
 *
 * Usage:
 *   pnpm tsx scripts/backfillKwmLooseFlags.ts                      # all weeks
 *   WEEK_FILTER=2025-08-30 pnpm tsx scripts/backfillKwmLooseFlags.ts
 *   WEEK_RANGE=12 pnpm tsx scripts/backfillKwmLooseFlags.ts        # trailing 12 weeks
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

function partitionForWeek(weekEndDateIso: string): string {
  // kwm is partitioned yearly. e.g. '2025-08-30' → 'keyword_weekly_metrics_2025'.
  const year = weekEndDateIso.slice(0, 4);
  return `keyword_weekly_metrics_${year}`;
}

async function main() {
  const weekFilter = process.env.WEEK_FILTER ?? null;
  const weekRange = process.env.WEEK_RANGE ? Number(process.env.WEEK_RANGE) : null;
  if (weekFilter !== null && weekRange !== null) {
    console.error('WEEK_FILTER and WEEK_RANGE are mutually exclusive.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 1_800_000, // 30 min ceiling per statement
  });
  const client = await pool.connect();

  try {
    console.log('\n=== Weeks to backfill ===');
    const { rows: weeks } = await client.query<{
      week_end_date: string;
      total: number;
      need_backfill: number;
    }>(
      `SELECT
         week_end_date::text,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NULL)::int AS need_backfill
       FROM keyword_weekly_metrics
       GROUP BY week_end_date
       ORDER BY week_end_date`,
    );
    let todo = weeks.filter((w) => w.need_backfill > 0);
    if (weekFilter !== null) {
      todo = todo.filter((w) => w.week_end_date.slice(0, 10) === weekFilter);
      console.log(`  WEEK_FILTER=${weekFilter} → ${todo.length} matching week(s)`);
    } else if (weekRange !== null) {
      todo = todo.slice(-weekRange);
      console.log(`  WEEK_RANGE=${weekRange} → trailing ${todo.length} week(s) of unbackfilled data`);
    }
    const totalNeed = todo.reduce((s, w) => s + w.need_backfill, 0);
    console.log(
      `  ${weeks.length} weeks total; ${todo.length} to process; ${totalNeed.toLocaleString()} rows`,
    );
    if (todo.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const startedAt = Date.now();

    for (let i = 0; i < todo.length; i++) {
      const w = todo[i];
      const ws = w.week_end_date.slice(0, 10);
      const partition = partitionForWeek(ws);
      const sliceStart = Date.now();

      // Direct child-partition UPDATE. One function call per row via
      // loose_title_flags_3 — wrapped in a row-valued scalar subquery
      // so the function evaluates exactly once and the 4 fields are
      // extracted in one go.
      //
      // (UPDATE...FROM LATERAL would also work and is slightly tighter,
      // but the row-valued subquery has more reliable cross-version
      // semantics for referencing the target table inside the SET.)
      //
      // The partition name is whitelisted by year derivation above
      // so the interpolation is safe.
      const result = await client.query(
        `
        UPDATE ${partition} kwm
        SET (
          keyword_in_title_1_loose,
          keyword_in_title_2_loose,
          keyword_in_title_3_loose,
          keyword_title_match_count_loose
        ) = (
          SELECT (lf).f1, (lf).f2, (lf).f3, (lf).match_count
          FROM loose_title_flags_3(
            st.search_term_normalized,
            kwm.top_clicked_product_1_title,
            kwm.top_clicked_product_2_title,
            kwm.top_clicked_product_3_title,
            kwm.keyword_in_title_1,
            kwm.keyword_in_title_2,
            kwm.keyword_in_title_3
          ) AS lf
        )
        FROM search_terms st
        WHERE kwm.search_term_id = st.id
          AND kwm.week_end_date = $1::date
          AND kwm.keyword_title_match_count_loose IS NULL
        `,
        [ws],
      );

      const sliceMs = Date.now() - sliceStart;
      const remaining = todo.length - i - 1;
      const avgMs = (Date.now() - startedAt) / (i + 1);
      const etaMin = Math.round((remaining * avgMs) / 60_000);
      const updated = result.rowCount ?? 0;
      console.log(
        ` [${(i + 1).toString().padStart(2)}/${todo.length}] ${ws} (${partition}) | ${updated.toLocaleString().padStart(10)} rows | ${(sliceMs / 1000).toFixed(1).padStart(6)}s | ETA ~${etaMin}m`,
      );
    }

    console.log(`\nTotal elapsed: ${Math.round((Date.now() - startedAt) / 60_000)} min`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
