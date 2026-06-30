/**
 * One-time backfill so the path-aware category filter is live IMMEDIATELY,
 * without waiting for the next weekly refreshSummary (full rebuild) or a Keepa
 * enrichment sync.
 *
 * Populates keyword_current_summary.top_clicked_category_path for the CURRENT
 * snapshot week from the slot-1 ASIN's asin_weekly_data.category_path, then
 * rebuilds the category-path facets (the typeahead option list + the runQuery
 * count short-circuit) for the current snapshot_version.
 *
 * The facet rebuild here is identical to refreshSummary's and the kcsKeepaSync
 * worker's, so all three stay in lockstep.
 *
 * Idempotent: the UPDATE only fills still-NULL rows; the facet rebuild is a
 * full DELETE+INSERT for the snapshot, so re-running is safe.
 *
 * Gated: requires CONFIRM_BACKFILL=1 — it touches ~1.5M rows on production.
 *
 * Run AFTER migration 0039 is applied and the code is deployed:
 *   CONFIRM_BACKFILL=1 node --env-file=.env.local --import tsx scripts/backfillCategoryPaths.ts
 */
import { Pool } from 'pg';

if (process.env.CONFIRM_BACKFILL !== '1') {
  console.error('Refusing to run without CONFIRM_BACKFILL=1 (this mutates production).');
  process.exit(1);
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    statement_timeout: 3_600_000, // 1-hour ceiling per statement
    max: 2,
  });
  const c = await pool.connect();
  try {
    const { rows: meta } = await c.query<{ wk: string; sv: string }>(
      `SELECT current_week_end_date::text AS wk, snapshot_version::text AS sv
       FROM keyword_current_summary_meta WHERE singleton = true`,
    );
    if (meta.length === 0) throw new Error('No keyword_current_summary_meta row — kcs not initialized');
    const { wk, sv } = meta[0];
    console.log(`[backfill] week=${wk} snapshot=${sv.slice(0, 8)}`);

    // 1. Fill the path column from the slot-1 ASIN's full category_path
    //    (mirrors refreshSummary's p1.category_path AS top_clicked_category_path).
    console.log('[backfill] phase=1 updating kcs.top_clicked_category_path …');
    const t1 = Date.now();
    const upd = await c.query(
      `UPDATE keyword_current_summary k
       SET top_clicked_category_path = a.category_path
       FROM asin_weekly_data a
       WHERE a.asin = k.top_clicked_product_1_asin_current
         AND a.week_end_date = $1::date
         AND k.top_clicked_category_path IS NULL`,
      [wk],
    );
    console.log(`[backfill] phase=1 done: updated ${(upd.rowCount ?? 0).toLocaleString()} rows in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    // 2. Rebuild the category-path facets for the current snapshot.
    console.log('[backfill] phase=2 rebuilding category-path facets …');
    await c.query(
      `DELETE FROM keyword_current_summary_leaf_category_facets WHERE snapshot_version = $1::uuid`,
      [sv],
    );
    const ins = await c.query(
      `INSERT INTO keyword_current_summary_leaf_category_facets
         (snapshot_version, category_path, default_severity_count, all_count)
       SELECT
         $1::uuid,
         top_clicked_category_path,
         COUNT(*) FILTER (
           WHERE fake_volume_severity_current IS NULL
              OR fake_volume_severity_current IN ('none', 'warning')
         )::int,
         COUNT(*)::int
       FROM keyword_current_summary
       WHERE top_clicked_category_path IS NOT NULL
       GROUP BY top_clicked_category_path`,
      [sv],
    );
    console.log(`[backfill] phase=2 done: ${(ins.rowCount ?? 0).toLocaleString()} path-facet rows`);

    // 3. Sanity report.
    const { rows: chk } = await c.query<{ with_path: string; total: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE top_clicked_category_path IS NOT NULL)::text AS with_path,
         COUNT(*)::text AS total
       FROM keyword_current_summary`,
    );
    console.log(`[backfill] kcs rows with a category path: ${Number(chk[0].with_path).toLocaleString()} / ${Number(chk[0].total).toLocaleString()}`);
    console.log('[backfill] done.');
  } finally {
    c.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('[backfill] FAILED', e);
  process.exit(1);
});
