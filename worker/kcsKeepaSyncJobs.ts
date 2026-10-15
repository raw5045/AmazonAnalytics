/**
 * Detached background worker that refreshes kcs Keepa aggregate
 * columns (lowest_price_cents, highest_price_cents, least_reviews,
 * most_reviews, avg_price_cents, avg_reviews, top_clicked_leaf_category,
 * top_clicked_category_path) + the category-path facets table — without
 * doing a full kcs rebuild.
 *
 * Triggered by `keepa/aggregates-sync-requested`, which is fired by:
 *   - the Keepa service watcher (inngest/functions/keepaServiceWatcher.ts):
 *     once the never-fetched lane drains after an import, and nightly from
 *     03:30 ET.
 *
 * Mirrors the worker/calibrationJobs.ts pattern:
 * synchronous-return + detached Promise + completion event.
 *
 * Phases:
 *   1. Build tmp_asin_enriched_sync (enrichedSyncSourceSql) — the
 *      asin_products catalog's current row per ASIN in status active,
 *      no_price or delisted (priced only when active; same row choice as
 *      the main refresh job's stageEnrichedAsins)
 *   2. UPDATE kcs rows in place — touches all 3.9M rows but only
 *      8 columns. Earlier full backfill clocked at ~67 min; subsequent
 *      runs should be faster (warm pages).
 *   3. Rebuild leaf-category facets for the current snapshot_version
 *
 * Fires `keepa/aggregates-sync.completed` with success/error info
 * on terminal state.
 */
import { Pool } from 'pg';
import { inngest } from '@/inngest/client';
import { warmExplorerLanding } from '@/lib/explorer/warmLanding';

const inflight = new Set<string>();

export interface StartKcsKeepaSyncArgs {
  /** The explorer (kcs) week the watcher requested the sync for. Used as the concurrency key. */
  weekEndDate: string;
}

/**
 * Phase 1's tmp_asin_enriched_sync statement, text and bound values together. Pure, so it is
 * pinned against the schema (inngest/functions/enrichedSourceSql.test.ts). Same row choice as
 * refreshSummary's stageEnrichedAsinsSql, over every ASIN rather than the active terms' top-3:
 * the catalog's one current row per ASIN in status active, no_price or delisted, priced only
 * when active.
 */
export function enrichedSyncSourceSql(): { text: string; values: unknown[] } {
  return {
    text: `CREATE UNLOGGED TABLE tmp_asin_enriched_sync AS
       SELECT
         a.asin,
         CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents,
         a.review_count,
         a.category_leaf,
         a.category_path
       FROM asin_products a
       WHERE a.enrichment_status IN ('active', 'no_price', 'delisted')`,
    values: [],
  };
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

        // Phase 1: build the enriched temp table (enrichedSyncSourceSql) — the
        // asin_products catalog's current row per ASIN (active, no_price or
        // delisted; priced only when active).
        // Same row choice as refreshSummary.stageEnrichedAsins but
        // here we use a real (not TEMP) UNLOGGED table since this job
        // doesn't run inside the txn that owns latest_per_term.
        log('phase=1 building tmp_asin_enriched_sync');
        await c.query(`DROP TABLE IF EXISTS tmp_asin_enriched_sync`);
        const phase1 = enrichedSyncSourceSql();
        await c.query(phase1.text, phase1.values);
        await c.query(`CREATE UNIQUE INDEX ON tmp_asin_enriched_sync (asin)`);
        const { rows: cnt } = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM tmp_asin_enriched_sync`,
        );
        log(`phase=1 done: ${cnt[0].n} active/no_price/delisted catalog rows`);

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

        // Phase 4: vacuum away the churn we just created. The Phase-2 UPDATE
        // rewrites ~4M rows (non-HOT — indexed columns change), leaving dead
        // tuples that make the explorer's rank-ordered landing scan wade
        // scattered heap pages until autovacuum catches up — observed as
        // 30-50s cold loads (2026-07-05 incident). Pay that cost here, inside
        // the overnight job, instead of on the first visitor of the morning.
        // VACUUM can't run in a transaction; this client runs autocommit.
        log('phase=4 VACUUM (ANALYZE) keyword_current_summary');
        const t4 = Date.now();
        await c.query(`VACUUM (ANALYZE) keyword_current_summary`);
        log(`phase=4 done in ${((Date.now() - t4) / 1000).toFixed(1)}s`);

        // Phase 5: re-warm the landing path (top-of-rank pages + hint bits)
        // so the next real visitor hits warm cache. Fail-soft inside.
        const warm = await warmExplorerLanding(c);
        log(`phase=5 landing warm-up: ${warm.ok ? `${warm.rows} rows in ${warm.ms}ms` : 'failed (non-fatal)'}`);

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
