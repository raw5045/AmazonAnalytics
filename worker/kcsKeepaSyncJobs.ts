/**
 * Detached background worker that refreshes kcs Keepa aggregate
 * columns (lowest_price_cents, highest_price_cents, least_reviews,
 * most_reviews, top_clicked_leaf_category, top_clicked_category_path)
 * + the category-path facets table — without doing a full kcs rebuild.
 *
 * Triggered by `keepa/aggregates-sync-requested` after a successful
 * Keepa enrichment run, so that newly-enriched ASINs (especially
 * those that weren't in any prior week's enrichment) show up in the
 * explorer within minutes of enrichment finishing — rather than
 * waiting until the next weekly refresh.
 *
 * Mirrors worker/calibrationJobs.ts / worker/keepaJobs.ts pattern:
 * synchronous-return + detached Promise + completion event.
 *
 * Phases:
 *   1. Build tmp_asin_enriched_sync — most-recent enrichment per ASIN
 *      ≤ kcs.current_week_end_date (same fall-back logic as the main
 *      refresh job's stageEnrichedAsins)
 *   2. UPDATE kcs rows in place — touches all 3.9M rows but only
 *      ~5 cols. Earlier full backfill clocked at ~67 min; subsequent
 *      runs should be faster (warm pages).
 *   3. Rebuild leaf-category facets for the current snapshot_version
 *
 * Fires `keepa/aggregates-sync.completed` with success/error info
 * on terminal state.
 */
import { Pool } from 'pg';
import { inngest } from '@/inngest/client';

const inflight = new Set<string>();

export interface StartKcsKeepaSyncArgs {
  /** The Keepa-enrichment week that just completed. Used as the concurrency key. */
  weekEndDate: string;
}

export function startKcsKeepaSyncJob(
  args: StartKcsKeepaSyncArgs,
): { started: boolean; reason?: string } {
  if (inflight.has(args.weekEndDate)) {
    return { started: false, reason: 'already-inflight' };
  }
  inflight.add(args.weekEndDate);

  (async () => {
    const log = (msg: string) => console.log(`[kcs-keepa-sync ${args.weekEndDate}] ${msg}`);
    let success = false;
    let errorMessage: string | null = null;
    let rowsUpdated = 0;
    let facetsInserted = 0;
    let durationMs = 0;
    const startedAt = Date.now();

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL!,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 3_600_000, // 1 hour ceiling per statement
      max: 2,
    });

    try {
      const c = await pool.connect();
      try {
        // Phase 0: get current_week_end_date + snapshot_version from meta
        const { rows: metaRows } = await c.query<{ cw: string; sv: string }>(
          `SELECT current_week_end_date::text AS cw, snapshot_version::text AS sv
           FROM keyword_current_summary_meta WHERE singleton = true`,
        );
        if (metaRows.length === 0) {
          throw new Error('No keyword_current_summary_meta row — kcs not initialized');
        }
        const { cw, sv } = metaRows[0];
        log(`syncing against kcs week=${cw} snapshot=${sv.slice(0, 8)}`);

        // Phase 1: build the enriched temp table (most-recent per ASIN ≤ cw).
        // Same query shape as refreshSummary.stageEnrichedAsins but
        // here we use a real (not TEMP) UNLOGGED table since this job
        // doesn't run inside the txn that owns latest_per_term.
        log('phase=1 building tmp_asin_enriched_sync');
        await c.query(`DROP TABLE IF EXISTS tmp_asin_enriched_sync`);
        await c.query(
          `CREATE UNLOGGED TABLE tmp_asin_enriched_sync AS
           SELECT DISTINCT ON (a.asin)
             a.asin,
             a.current_price_cents,
             a.review_count,
             a.category_leaf,
             a.category_path
           FROM asin_weekly_data a
           WHERE a.week_end_date <= $1::date
             AND a.enrichment_status = 'active'
           ORDER BY a.asin, a.week_end_date DESC`,
          [cw],
        );
        await c.query(`CREATE UNIQUE INDEX ON tmp_asin_enriched_sync (asin)`);
        const { rows: cnt } = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM tmp_asin_enriched_sync`,
        );
        log(`phase=1 done: ${cnt[0].n} enriched ASINs in scope`);

        // Phase 2: UPDATE kcs with aggregates over top-3 ASINs.
        // Joins kwm to look up the 3 ASINs at kcs.current_week_end_date,
        // then LEFT JOINs 3x to the enriched temp table.
        log('phase=2 updating kcs aggregates');
        const t2 = Date.now();
        const upd = await c.query(`
          UPDATE keyword_current_summary kcs
          SET
            lowest_price_cents  = LEAST(p1.current_price_cents,  p2.current_price_cents,  p3.current_price_cents),
            highest_price_cents = GREATEST(p1.current_price_cents, p2.current_price_cents, p3.current_price_cents),
            least_reviews       = LEAST(p1.review_count,        p2.review_count,        p3.review_count),
            most_reviews        = GREATEST(p1.review_count,     p2.review_count,        p3.review_count),
            avg_price_cents     = (SELECT AVG(v)::bigint FROM unnest(ARRAY[p1.current_price_cents, p2.current_price_cents, p3.current_price_cents]) v WHERE v IS NOT NULL),
            avg_reviews         = (SELECT AVG(v)::int    FROM unnest(ARRAY[p1.review_count,        p2.review_count,        p3.review_count])        v WHERE v IS NOT NULL),
            top_clicked_leaf_category = p1.category_leaf,
            top_clicked_category_path = p1.category_path
          FROM keyword_weekly_metrics kwm
          LEFT JOIN tmp_asin_enriched_sync p1 ON p1.asin = kwm.top_clicked_product_1_asin
          LEFT JOIN tmp_asin_enriched_sync p2 ON p2.asin = kwm.top_clicked_product_2_asin
          LEFT JOIN tmp_asin_enriched_sync p3 ON p3.asin = kwm.top_clicked_product_3_asin
          WHERE kwm.search_term_id = kcs.search_term_id
            AND kwm.week_end_date = kcs.current_week_end_date
        `);
        rowsUpdated = upd.rowCount ?? 0;
        log(`phase=2 done: updated ${rowsUpdated.toLocaleString()} rows in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

        // Phase 3: rebuild category-path facets for current snapshot
        log('phase=3 rebuilding category-path facets');
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
        facetsInserted = ins.rowCount ?? 0;
        log(`phase=3 done: ${facetsInserted.toLocaleString()} path facets`);

        await c.query(`DROP TABLE tmp_asin_enriched_sync`);
        success = true;
      } finally {
        c.release();
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      console.error(`[kcs-keepa-sync ${args.weekEndDate}] failed:`, e);
    } finally {
      await pool.end();
      inflight.delete(args.weekEndDate);
      durationMs = Date.now() - startedAt;

      // Fire completion event (best-effort — orchestrator's
      // waitForEvent handles missed events via timeout)
      try {
        await inngest.send({
          name: 'keepa/aggregates-sync.completed',
          data: {
            weekEndDate: args.weekEndDate,
            success,
            errorMessage,
            rowsUpdated,
            facetsInserted,
            durationMs,
          },
        });
      } catch (e) {
        console.error(`[kcs-keepa-sync ${args.weekEndDate}] failed to fire completion event:`, e);
      }
    }
  })();

  return { started: true };
}
