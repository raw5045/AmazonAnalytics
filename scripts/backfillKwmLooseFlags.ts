/**
 * Backfill loose match flags using:
 *   - search_term_loose_requirements (precomputed padded needles per term)
 *   - flat POSITION-based predicate (no per-row function calls)
 *   - direct child-partition target (no parent dispatch, no ctid bug)
 *   - rank filter: only rows with actual_rank <= LOOSE_RANK_THRESHOLD
 *
 * Algorithm:
 *   1. Per week, compute each row's 3 normalized titles ONCE via a CTE
 *      (n1, n2, n3 — padded lowercase alphanum-only strings).
 *   2. JOIN to search_term_loose_requirements for the precomputed
 *      bidirectional candidate forms.
 *   3. Apply the flat predicate that does 32 POSITION checks max per
 *      slot — no unnest, no function calls, no array allocation.
 *   4. Fallback for "overflow" rows (>8-token search terms, ~0.26% of
 *      kwm): falls through to the slower loose_match_title function.
 *
 * Resume marker: keyword_title_match_count_loose IS NULL combined with
 * actual_rank <= LOOSE_RANK_THRESHOLD. Rank > threshold rows are
 * intentionally never written (they're noise; no traffic).
 *
 * Connection: pg.Pool TCP. neon-http times out on multi-min UPDATEs.
 *
 * Usage:
 *   pnpm tsx scripts/backfillKwmLooseFlags.ts
 *   WEEK_FILTER=2025-08-30 pnpm tsx scripts/backfillKwmLooseFlags.ts
 *   WEEK_RANGE=12 pnpm tsx scripts/backfillKwmLooseFlags.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
import { looseMatchPredicate, looseTitleNormSql } from '@/lib/analytics/loosePredicate';

/** Rank threshold: rows with actual_rank > this aren't computed (functionally no traffic). */
const LOOSE_RANK_THRESHOLD = 1_000_000;

function partitionForWeek(weekEndDateIso: string): string {
  const year = weekEndDateIso.slice(0, 4);
  return `keyword_weekly_metrics_${year}`;
}

/**
 * Build the per-week UPDATE statement. The shape:
 *   UPDATE <partition> kwm
 *   SET (...4 loose cols...) = (
 *     SELECT f1, f2, f3, match_count FROM (
 *       -- flat predicate using r.* and n1/n2/n3 from the inner CTE
 *     )
 *   )
 *   FROM search_term_loose_requirements r
 *   WHERE kwm.search_term_id = r.search_term_id
 *     AND kwm.week_end_date = $1
 *     AND kwm.actual_rank <= LOOSE_RANK_THRESHOLD
 *     AND kwm.keyword_title_match_count_loose IS NULL
 *
 * The normalized titles are computed once per row in the inner SELECT;
 * the predicate references n1/n2/n3 by name rather than re-evaluating.
 */
function buildUpdateSql(partition: string): string {
  // Inline title normalization (still cheap when done once per row)
  const n1 = looseTitleNormSql('kwm.top_clicked_product_1_title');
  const n2 = looseTitleNormSql('kwm.top_clicked_product_2_title');
  const n3 = looseTitleNormSql('kwm.top_clicked_product_3_title');

  // Predicates with n1/n2/n3 references (no inline regex re-eval)
  const p1 = looseMatchPredicate('r', 'n1');
  const p2 = looseMatchPredicate('r', 'n2');
  const p3 = looseMatchPredicate('r', 'n3');

  // Per-slot flag with strict-true and null-title short-circuits + overflow fallback
  const slotFlag = (titleSql: string, strictSql: string, predicate: string, normCol: string) => `(
    CASE
      WHEN ${titleSql} IS NULL THEN NULL
      WHEN ${strictSql} IS TRUE THEN TRUE
      WHEN r.overflow IS TRUE THEN
        loose_match_title(
          (SELECT search_term_normalized FROM search_terms WHERE id = r.search_term_id),
          ${titleSql}
        )
      ELSE ${predicate}
    END
  )`;

  const f1 = slotFlag('kwm.top_clicked_product_1_title', 'kwm.keyword_in_title_1', p1, 'n1');
  const f2 = slotFlag('kwm.top_clicked_product_2_title', 'kwm.keyword_in_title_2', p2, 'n2');
  const f3 = slotFlag('kwm.top_clicked_product_3_title', 'kwm.keyword_in_title_3', p3, 'n3');

  return `
    UPDATE ${partition} kwm
    SET (
      keyword_in_title_1_loose,
      keyword_in_title_2_loose,
      keyword_in_title_3_loose,
      keyword_title_match_count_loose
    ) = (
      SELECT f1, f2, f3, (
        COALESCE(f1::int, 0) + COALESCE(f2::int, 0) + COALESCE(f3::int, 0)
      )::smallint
      FROM (
        SELECT
          ${n1} AS n1,
          ${n2} AS n2,
          ${n3} AS n3
      ) norm
      CROSS JOIN LATERAL (
        SELECT ${f1} AS f1, ${f2} AS f2, ${f3} AS f3
      ) flags
    )
    FROM search_term_loose_requirements r
    WHERE kwm.search_term_id = r.search_term_id
      AND kwm.week_end_date = $1::date
      AND kwm.actual_rank <= ${LOOSE_RANK_THRESHOLD}
      AND kwm.keyword_title_match_count_loose IS NULL
  `;
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
    statement_timeout: 1_800_000,
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
         COUNT(*) FILTER (
           WHERE actual_rank <= ${LOOSE_RANK_THRESHOLD}
             AND keyword_title_match_count_loose IS NULL
         )::int AS need_backfill
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
      console.log(`  WEEK_RANGE=${weekRange} → trailing ${todo.length} week(s)`);
    }
    const totalNeed = todo.reduce((s, w) => s + w.need_backfill, 0);
    console.log(
      `  ${weeks.length} weeks total; ${todo.length} to process; ${totalNeed.toLocaleString()} rows (rank ≤ ${LOOSE_RANK_THRESHOLD.toLocaleString()})`,
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

      const result = await client.query(buildUpdateSql(partition), [ws]);

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
