/**
 * Count distinct ASINs we'd enrich via Keepa for the most recent
 * week, given the filter rules approved on May 14:
 *
 *   - rank <= 500,000
 *   - top_clicked_category_1 NOT IN (digital + grocery-Fresh/Protein + gift cards)
 *   - Union across slot 1, slot 2, slot 3 (non-null)
 *
 * Also breaks down per-slot and shows the overlap so we know whether
 * "top 3" is roughly 3x slot 1, or much less because of dedup.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
import { EXCLUDED_CATEGORIES_ARRAY } from '@/lib/keepa/categoryExclusions';

const EXCLUDED_CATEGORIES = EXCLUDED_CATEGORIES_ARRAY;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 600_000 });
  const c = await pool.connect();
  try {
    // Get current week from meta
    const { rows: meta } = await c.query<{ week: string; year: string }>(`
      SELECT current_week_end_date::text AS week,
             EXTRACT(YEAR FROM current_week_end_date)::text AS year
      FROM keyword_current_summary_meta
      WHERE singleton = true
    `);
    const week = meta[0].week;
    const partition = `keyword_weekly_metrics_${meta[0].year}`;
    console.log(`\nCurrent week: ${week}  (partition: ${partition})`);
    console.log(`Excluded categories (${EXCLUDED_CATEGORIES.length}): ${EXCLUDED_CATEGORIES.join(', ')}\n`);

    // Top-level: how many kwm rows pass the filter?
    const { rows: scope } = await c.query<{
      total_rows_in_week: number;
      rows_rank_le_100k: number;
      rows_after_category_exclude: number;
    }>(`
      SELECT
        COUNT(*)::int AS total_rows_in_week,
        COUNT(*) FILTER (WHERE actual_rank <= 100000)::int AS rows_rank_le_100k,
        COUNT(*) FILTER (
          WHERE actual_rank <= 100000
            AND (top_clicked_category_1 IS NULL OR top_clicked_category_1 NOT IN (${EXCLUDED_CATEGORIES.map((_, i) => `$${i + 2}`).join(',')}))
        )::int AS rows_after_category_exclude
      FROM ${partition}
      WHERE week_end_date = $1::date
    `, [week, ...EXCLUDED_CATEGORIES]);
    const s = scope[0];
    console.log(`Scope funnel:`);
    console.log(`  rows in week:                    ${s.total_rows_in_week.toLocaleString().padStart(12)}`);
    console.log(`  ↳ rank ≤ 100k:                   ${s.rows_rank_le_100k.toLocaleString().padStart(12)}  (${(s.rows_rank_le_100k / s.total_rows_in_week * 100).toFixed(1)}%)`);
    console.log(`  ↳ + category not in exclusion:   ${s.rows_after_category_exclude.toLocaleString().padStart(12)}  (${(s.rows_after_category_exclude / s.total_rows_in_week * 100).toFixed(1)}%)`);

    // Per-slot distinct ASIN counts
    const { rows: bySlot } = await c.query<{
      slot1_nonnull: number;
      slot2_nonnull: number;
      slot3_nonnull: number;
      slot1_distinct: number;
      slot2_distinct: number;
      slot3_distinct: number;
    }>(`
      SELECT
        COUNT(top_clicked_product_1_asin)::int AS slot1_nonnull,
        COUNT(top_clicked_product_2_asin)::int AS slot2_nonnull,
        COUNT(top_clicked_product_3_asin)::int AS slot3_nonnull,
        COUNT(DISTINCT top_clicked_product_1_asin)::int AS slot1_distinct,
        COUNT(DISTINCT top_clicked_product_2_asin)::int AS slot2_distinct,
        COUNT(DISTINCT top_clicked_product_3_asin)::int AS slot3_distinct
      FROM ${partition}
      WHERE week_end_date = $1::date
        AND actual_rank <= 100000
        AND (top_clicked_category_1 IS NULL OR top_clicked_category_1 NOT IN (${EXCLUDED_CATEGORIES.map((_, i) => `$${i + 2}`).join(',')}))
    `, [week, ...EXCLUDED_CATEGORIES]);
    const b = bySlot[0];
    console.log(`\nPer-slot ASIN coverage:`);
    console.log(`  slot 1: ${b.slot1_nonnull.toLocaleString().padStart(10)} non-null  →  ${b.slot1_distinct.toLocaleString().padStart(8)} distinct`);
    console.log(`  slot 2: ${b.slot2_nonnull.toLocaleString().padStart(10)} non-null  →  ${b.slot2_distinct.toLocaleString().padStart(8)} distinct`);
    console.log(`  slot 3: ${b.slot3_nonnull.toLocaleString().padStart(10)} non-null  →  ${b.slot3_distinct.toLocaleString().padStart(8)} distinct`);

    // Combined distinct across slots 1+2+3
    const { rows: total } = await c.query<{ total_distinct: number }>(`
      SELECT COUNT(DISTINCT asin)::int AS total_distinct
      FROM ${partition} kwm
      CROSS JOIN LATERAL (VALUES
        (kwm.top_clicked_product_1_asin),
        (kwm.top_clicked_product_2_asin),
        (kwm.top_clicked_product_3_asin)
      ) AS t(asin)
      WHERE kwm.week_end_date = $1::date
        AND kwm.actual_rank <= 100000
        AND (kwm.top_clicked_category_1 IS NULL OR kwm.top_clicked_category_1 NOT IN (${EXCLUDED_CATEGORIES.map((_, i) => `$${i + 2}`).join(',')}))
        AND t.asin IS NOT NULL
    `, [week, ...EXCLUDED_CATEGORIES]);
    const td = total[0].total_distinct;
    console.log(`\n=== Total distinct ASINs to enrich (slots 1+2+3, deduped) ===`);
    console.log(`  ${td.toLocaleString()} ASINs`);

    // Keepa token math: 1 token per ASIN at base, 250 tokens/min
    const tokens250 = td;
    const minutes250 = tokens250 / 250;
    const hours250 = minutes250 / 60;
    console.log(`\nKeepa estimates (1 token / ASIN, base tier):`);
    console.log(`  At 250 tokens/min: ${tokens250.toLocaleString()} tokens → ${hours250.toFixed(1)} hours`);
    console.log(`  At 500 tokens/min:                                  → ${(hours250 / 2).toFixed(1)} hours`);
    console.log(`  At 1000 tokens/min:                                 → ${(hours250 / 4).toFixed(1)} hours`);

    // Compare to slot-1-only (the cheaper alternative)
    console.log(`\nSlot-1-only alternative (cheaper):`);
    console.log(`  ${b.slot1_distinct.toLocaleString()} ASINs`);
    console.log(`  At 250 tokens/min: ${(b.slot1_distinct / 250 / 60).toFixed(1)} hours`);

    // Overlap diagnostic
    console.log(`\nSlot dedup factor: ${(td / b.slot1_distinct).toFixed(2)}x (1.0 = full overlap, 3.0 = no overlap)`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
