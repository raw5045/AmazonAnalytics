/**
 * Pre-Phase-1 diagnostic. Two questions, answered against one
 * representative week:
 *
 *   1. What fraction of rows need expensive loose-match computation
 *      (at least one slot has a non-NULL title AND strict is not TRUE)?
 *      If most rows fall into the cheap fast path, the two-pass strategy
 *      is a big win.
 *
 *   2. Distinct-title cardinality per week. If distinct titles are a
 *      large share of title occurrences, a title cache amortizes poorly
 *      (validates the GPT critique).
 *
 * Read-only. Uses pg.Pool TCP (the aggregates would time out on neon-http).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const WEEKS = ['2025-08-30', '2026-04-25'];

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 300_000,
  });
  const c = await pool.connect();
  try {
    for (const w of WEEKS) {
      const year = w.slice(0, 4);
      const partition = `keyword_weekly_metrics_${year}`;
      console.log(`\n=== ${w}  (partition: ${partition}) ===`);

      // 1. Row distribution: cheap fast path vs needs computation
      const t0 = Date.now();
      const { rows: dist } = await c.query<{
        total: number;
        all_null_titles: number;
        all_strict_true_or_null: number;
        needs_loose_compute: number;
      }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE
             top_clicked_product_1_title IS NULL
             AND top_clicked_product_2_title IS NULL
             AND top_clicked_product_3_title IS NULL
           )::int AS all_null_titles,
           COUNT(*) FILTER (WHERE
             (top_clicked_product_1_title IS NULL OR keyword_in_title_1 IS TRUE)
             AND (top_clicked_product_2_title IS NULL OR keyword_in_title_2 IS TRUE)
             AND (top_clicked_product_3_title IS NULL OR keyword_in_title_3 IS TRUE)
           )::int AS all_strict_true_or_null,
           COUNT(*) FILTER (WHERE
             (top_clicked_product_1_title IS NOT NULL AND COALESCE(keyword_in_title_1, FALSE) = FALSE)
             OR (top_clicked_product_2_title IS NOT NULL AND COALESCE(keyword_in_title_2, FALSE) = FALSE)
             OR (top_clicked_product_3_title IS NOT NULL AND COALESCE(keyword_in_title_3, FALSE) = FALSE)
           )::int AS needs_loose_compute
         FROM ${partition}
         WHERE week_end_date = $1::date`,
        [w],
      );
      const d = dist[0];
      const pctCheap = (d.all_strict_true_or_null / d.total * 100).toFixed(1);
      const pctExpensive = (d.needs_loose_compute / d.total * 100).toFixed(1);
      console.log(`  Total rows: ${d.total.toLocaleString()}`);
      console.log(`  All-null titles (no loose needed): ${d.all_null_titles.toLocaleString()} (${(d.all_null_titles/d.total*100).toFixed(1)}%)`);
      console.log(`  All strict-true-or-null (cheap fast path): ${d.all_strict_true_or_null.toLocaleString()} (${pctCheap}%)`);
      console.log(`  Needs expensive loose compute: ${d.needs_loose_compute.toLocaleString()} (${pctExpensive}%)`);

      // 2. Title cardinality
      const { rows: cards } = await c.query<{
        occurrences: number;
        distinct_titles: number;
      }>(
        `SELECT COUNT(*)::int AS occurrences, COUNT(DISTINCT title)::int AS distinct_titles
         FROM (
           SELECT top_clicked_product_1_title AS title FROM ${partition}
             WHERE week_end_date = $1::date AND top_clicked_product_1_title IS NOT NULL
           UNION ALL
           SELECT top_clicked_product_2_title FROM ${partition}
             WHERE week_end_date = $1::date AND top_clicked_product_2_title IS NOT NULL
           UNION ALL
           SELECT top_clicked_product_3_title FROM ${partition}
             WHERE week_end_date = $1::date AND top_clicked_product_3_title IS NOT NULL
         ) t`,
        [w],
      );
      const card = cards[0];
      const ratio = (card.occurrences / card.distinct_titles).toFixed(1);
      console.log(`  Title occurrences (across 3 slots): ${card.occurrences.toLocaleString()}`);
      console.log(`  Distinct titles: ${card.distinct_titles.toLocaleString()} (${(card.distinct_titles/card.occurrences*100).toFixed(1)}% of occurrences)`);
      console.log(`  Avg uses per distinct title: ${ratio}× (cache amortization factor — higher is better for caching)`);

      console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
