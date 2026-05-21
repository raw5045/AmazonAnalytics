/**
 * Summary refresh job — rebuilds keyword_current_summary from kwm.
 *
 * Called as the final phase of processFileImport (after mark_imported is
 * effectively staged but before the file is committed as fully done).
 * For Plan 3.1 MVP, this populates the critical fields the Plan 3.2
 * explorer depends on:
 *
 *   ✓ current_week_end_date, current_rank
 *   ✓ prior_week_rank, rank_4w_ago, rank_13w_ago, rank_26w_ago, rank_52w_ago
 *   ✓ improvement_1w / 4w / 13w / 26w / 52w
 *   ✓ ever_top_50k
 *   ✓ last_seen_week, weeks_since_seen
 *   ✓ fake_volume_severity_current
 *   ✓ snapshot fields (category, asins, titles, in-title flags, match count)
 *
 * Defaulted to safe values for Plan 3.1, enriched in Plan 3.5:
 *   - consecutive_improvement_streak = 0  (needs window function/recursive CTE)
 *   - has_unranked_week / unranked_week_count / unranked_after_top_50k = false/0
 *     (need cross-join against reporting_weeks calendar)
 *
 * Filter: active terms only (last_seen_week >= current_week_end_date - 28 days).
 *
 * Strategy: stage rows in temp tables for clean intermediate plans, then
 * INSERT into the parallel `keyword_current_summary_stage` table. After
 * commit, atomically swap names with the live table via three RENAMEs
 * in a tiny transaction (~ms). Concurrent reads of
 * keyword_current_summary are NEVER blocked beyond that brief metadata
 * swap — the prior approach (TRUNCATE + INSERT in one transaction on
 * the live table) blocked the explorer for ~3 min during the INSERT.
 *
 * Estimated cost: ~30 minutes on ~4M active terms (post-covering-index
 * fix; was ~155 min before migration 0011). Connection: pg.Pool with
 * TCP keepalives (the @neondatabase/serverless HTTP driver would time
 * out on long INSERTs).
 */
import { Pool, type PoolClient } from 'pg';
import { pickFitForWeek, type FitParams, type PiecewiseFit } from '@/lib/analytics/volumeModel';
import type { FitParamsJson } from '@/db/schema/modelCalibrationRuns';

export interface RefreshSummaryResult {
  rowsWritten: number;
  durationMs: number;
  currentWeekEndDate: string;
}

export async function refreshKeywordCurrentSummary(): Promise<RefreshSummaryResult> {
  const startedAt = Date.now();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const pool = new Pool({
    connectionString: dbUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    statement_timeout: 1_800_000, // 30 min ceiling per statement
  });

  const client = await pool.connect();
  let currentWeekEndDate: string | null = null;
  let rowsWritten = 0;

  try {
    // 0. Determine the current week — the most recent fully-imported week.
    const { rows: refRows } = await client.query<{ current_week: string }>(
      `SELECT MAX(week_end_date)::date AS current_week
       FROM reporting_weeks WHERE is_complete = true`,
    );
    if (refRows.length === 0 || !refRows[0].current_week) {
      throw new Error('refreshSummary: no completed reporting_weeks found');
    }
    currentWeekEndDate = refRows[0].current_week as unknown as string;

    // 0a. Pick the volume-model fit that applies to current_week_end_date.
    //     pickFitForWeek picks the latest fit with calibration_month
    //     ≤ end-of-current-week's-month (or earliest available with
    //     isExtrapolated=true if none qualifies).
    //
    //     The fit may be piecewise (multiple (β, A) segments separated
    //     by breakpoints) — we build a SQL CASE WHEN expression
    //     dynamically and bind the segment + breakpoint values as
    //     params. For legacy single-segment fits, the expression
    //     collapses to a single (A * power(rank, -β))::bigint.
    //
    //     When zero fits exist (cold start), the chosenFit is null
    //     and the column stays NULL. Next refresh after a fit lands
    //     will fill it in.
    const { rows: fitRows } = await client.query<{
      id: string;
      calibration_month_end_date: string;
      fitted_at: string;
      beta: string;
      scale_factor: string;
      fit_params: FitParamsJson | null;
    }>(
      `SELECT id, calibration_month_end_date::text, fitted_at::text,
              beta::text, scale_factor::text, fit_params
       FROM model_calibration_runs`,
    );
    const fits: FitParams[] = fitRows.map((r) => {
      const fp = r.fit_params;
      const segments = fp?.segments ?? [{ beta: parseFloat(r.beta), scaleFactor: parseFloat(r.scale_factor) }];
      const breakpoints = fp?.breakpoints ?? [];
      return {
        calibrationMonthEndDate: r.calibration_month_end_date,
        fittedAt: r.fitted_at,
        beta: segments[0].beta,
        scaleFactor: segments[0].scaleFactor,
        breakpoints,
        segments,
      };
    });
    const volumeSelection = pickFitForWeek(currentWeekEndDate, fits);
    const fitRunIdById = new Map<string, string>();
    for (const r of fitRows) fitRunIdById.set(`${r.calibration_month_end_date}|${r.fitted_at}`, r.id);
    const chosenFitRunId = volumeSelection
      ? fitRunIdById.get(
          `${volumeSelection.fit.calibrationMonthEndDate}|${volumeSelection.fit.fittedAt}`,
        ) ?? null
      : null;
    const chosenIsExtrapolated = volumeSelection?.isExtrapolated ?? false;

    // Build the SQL CASE WHEN expression + param list for the picked
    // fit. Params start at $2 because $1 is currentWeekEndDate (used
    // later in the INSERT for the `weeks_since_seen` calculation).
    const piecewiseSql = volumeSelection
      ? buildPiecewiseSql(volumeSelection.fit, 'l.actual_rank', 2)
      : null;

    // Stage-and-swap pattern (Plan 3.2 perf fix #4):
    //   - Build the new snapshot inside `keyword_current_summary_stage`,
    //     a parallel table with identical structure (created in migration
    //     0012). This holds an EXCLUSIVE lock on _stage but no lock on the
    //     live `keyword_current_summary`.
    //   - At the end, do a brief metadata-only RENAME swap: the live
    //     table becomes _stage, _stage becomes live. Reader-blocking
    //     window goes from ~3 min (the prior INSERT duration) to a
    //     few milliseconds (just the system catalog update).
    //
    // Everything from BEGIN through the final INSERT runs in one
    // transaction so the temp tables persist across stages. The RENAME
    // swap is a separate, very short transaction at the end.
    await client.query('BEGIN');

    // Wipe stale data from the previous refresh's stage table. (After a
    // successful swap, _stage holds the prior snapshot; we don't need
    // it.) TRUNCATE on _stage takes ACCESS EXCLUSIVE on _stage but no
    // one reads _stage, so this doesn't block any explorer queries.
    await client.query('TRUNCATE keyword_current_summary_stage');

    // 1. latest_per_term — most recent kwm row per active term.
    //    Active = seen within the last 28 days of current_week_end_date.
    //    Materialized as a temp table so subsequent steps reuse the result
    //    without re-scanning kwm.
    await stageLatestPerTerm(client);

    // 1a. Stage Keepa-enriched (price/reviews/leaf-category) data for
    //     every top-3 ASIN at the current week. Joined into the INSERT
    //     below to populate the new aggregate columns.
    await stageEnrichedAsins(client, currentWeekEndDate);

    // 2. rank_at_offset(N) for N in {1, 4, 13, 26, 52} weeks ago.
    //    Each offset is the actual_rank in the EXACT week N*7 days before
    //    each term's current_week_end_date. NULL when the term wasn't
    //    observed that exact week (treated as "unranked then" by the spec).
    for (const weeks of [1, 4, 13, 26, 52]) {
      await stageRankAtOffset(client, weeks);
    }

    // 3. Loose-match flags are now read directly from kwm (the source of
    //    truth after migration 0016+). They're already pulled into
    //    latest_per_term, so no separate computation stage needed.

    // ever_top_50k DEFERRED to Plan 3.5: a full-history scan of kwm joined
    // to latest_per_term takes 1+ hours via Neon's cold-page prefetch
    // (135M rows still NULL severity-wise post-scoped-backfill, so they're
    // also cold). For Plan 3.1 we default ever_top_50k to false; once
    // the overnight full-history backfill warms the cache and the aggregate
    // can complete in reasonable time, we'll add a one-off "ever_top_50k
    // compute" job and decide whether to keep it inline in the refresh
    // or maintain it incrementally on each import.

    // 4. INSERT into the stage table (the live table is untouched).
    //    estimated_monthly_volume_current is computed inline via a
    //    piecewise SQL CASE expression built from the chosen fit
    //    (or NULL when no fit exists). Param indices for the
    //    piecewise expression start at $2; the existing
    //    weeks_since_seen calc uses $1.
    const volumeExpression = piecewiseSql ? piecewiseSql.sql : 'NULL::bigint';
    const volumeParams = piecewiseSql ? piecewiseSql.params : [];
    const insertResult = await client.query(
      `
      INSERT INTO keyword_current_summary_stage (
        search_term_id, current_week_end_date, current_rank,
        prior_week_rank, rank_4w_ago, rank_13w_ago, rank_26w_ago, rank_52w_ago,
        improvement_1w, improvement_4w, improvement_13w, improvement_26w, improvement_52w,
        consecutive_improvement_streak, ever_top_50k,
        has_unranked_week, unranked_week_count, unranked_after_top_50k,
        last_seen_week, weeks_since_seen,
        fake_volume_severity_current,
        top_clicked_category_1_current,
        top_clicked_product_1_asin_current,
        top_clicked_product_1_title_current,
        top_clicked_product_1_click_share_current,
        top_clicked_product_1_conversion_share_current,
        keyword_in_title_1_current, keyword_in_title_2_current, keyword_in_title_3_current,
        keyword_title_match_count_current,
        keyword_in_title_1_loose_current, keyword_in_title_2_loose_current, keyword_in_title_3_loose_current,
        keyword_title_match_count_loose_current,
        estimated_monthly_volume_current,
        lowest_price_cents, highest_price_cents,
        least_reviews, most_reviews,
        top_clicked_leaf_category,
        updated_at
      )
      SELECT
        l.search_term_id,
        l.week_end_date,
        l.actual_rank,
        r1.actual_rank,
        r4.actual_rank,
        r13.actual_rank,
        r26.actual_rank,
        r52.actual_rank,
        (r1.actual_rank - l.actual_rank),
        (r4.actual_rank - l.actual_rank),
        (r13.actual_rank - l.actual_rank),
        (r26.actual_rank - l.actual_rank),
        (r52.actual_rank - l.actual_rank),
        0 AS consecutive_improvement_streak,
        false AS ever_top_50k, -- deferred to Plan 3.5; see note above
        false AS has_unranked_week,
        0 AS unranked_week_count,
        false AS unranked_after_top_50k,
        l.week_end_date AS last_seen_week,
        -- date - date returns int (days). Divide by 7 for weeks.
        (($1::date - l.week_end_date) / 7)::int AS weeks_since_seen,
        -- Apply the rank-threshold mask: at actual_rank > 100,000 the
        -- click_share/conversion_share signals are too noisy to be
        -- meaningful, so we treat severity as 'none' regardless of what
        -- was computed at import time. See importFile.ts
        -- FAKE_VOLUME_RANK_THRESHOLD for the equivalent forward-going
        -- rule. Keeps explorer's severity filter clean of low-volume
        -- noise without requiring a kwm backfill.
        CASE
          WHEN l.actual_rank > 100000 THEN 'none'::fake_volume_severity
          ELSE l.fake_volume_severity
        END AS fake_volume_severity,
        l.top_clicked_category_1,
        l.top_clicked_product_1_asin,
        l.top_clicked_product_1_title,
        l.top_clicked_product_1_click_share,
        l.top_clicked_product_1_conversion_share,
        l.keyword_in_title_1,
        l.keyword_in_title_2,
        l.keyword_in_title_3,
        l.keyword_title_match_count,
        l.keyword_in_title_1_loose AS in_title_1_loose,
        l.keyword_in_title_2_loose AS in_title_2_loose,
        l.keyword_in_title_3_loose AS in_title_3_loose,
        l.keyword_title_match_count_loose AS title_match_count_loose,
        -- Estimated volume — see buildPiecewiseSql (single or
        -- multi-segment CASE WHEN). NULL when no fit was selected.
        ${volumeExpression} AS estimated_monthly_volume_current,
        -- Keepa price/review aggregates over the top-3 ASINs at the
        -- current week. LEAST/GREATEST ignore NULLs, so a row whose
        -- top-3 are only partially enriched still gets sensible
        -- min/max over whatever IS enriched. All NULL → all 3 ASINs
        -- unenriched → the row won't appear in price/reviews filters.
        LEAST(p1.current_price_cents, p2.current_price_cents, p3.current_price_cents) AS lowest_price_cents,
        GREATEST(p1.current_price_cents, p2.current_price_cents, p3.current_price_cents) AS highest_price_cents,
        LEAST(p1.review_count, p2.review_count, p3.review_count) AS least_reviews,
        GREATEST(p1.review_count, p2.review_count, p3.review_count) AS most_reviews,
        -- Leaf category from the slot-1 (most-clicked) ASIN.
        -- Falls back to NULL if slot-1 isn't enriched (we could
        -- fall through to slot-2/3 but that would muddy the signal —
        -- the leaf cat of the SECOND product isn't really "this
        -- keyword's category").
        p1.category_leaf AS top_clicked_leaf_category,
        NOW()
      FROM latest_per_term l
      LEFT JOIN rank_at_1w r1 ON r1.search_term_id = l.search_term_id
      LEFT JOIN rank_at_4w r4 ON r4.search_term_id = l.search_term_id
      LEFT JOIN rank_at_13w r13 ON r13.search_term_id = l.search_term_id
      LEFT JOIN rank_at_26w r26 ON r26.search_term_id = l.search_term_id
      LEFT JOIN rank_at_52w r52 ON r52.search_term_id = l.search_term_id
      LEFT JOIN asin_enriched_current p1 ON p1.asin = l.top_clicked_product_1_asin
      LEFT JOIN asin_enriched_current p2 ON p2.asin = l.top_clicked_product_2_asin
      LEFT JOIN asin_enriched_current p3 ON p3.asin = l.top_clicked_product_3_asin
      `,
      [currentWeekEndDate, ...volumeParams],
    );
    rowsWritten = insertResult.rowCount ?? 0;

    await client.query('COMMIT');

    // 5. Swap stage <-> live in a separate, very short transaction.
    //    Three RENAMEs are pure metadata operations on the system catalog;
    //    each takes ACCESS EXCLUSIVE briefly but completes in
    //    milliseconds. Net reader-blocking window: ~tens of ms.
    //
    //    After this commit:
    //      - The previously-live `keyword_current_summary` is now the
    //        empty-pending-truncate `_stage` (will be wiped at the start
    //        of the next refresh).
    //      - The freshly-built rows are now live as
    //        `keyword_current_summary`.
    //
    //    Index names rotate with their tables and are not renamed —
    //    EXPLAIN output may transiently show indexes named like
    //    `keyword_current_summary_stage_<col>_idx` against the live
    //    table. Functional but visually quirky.
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE keyword_current_summary RENAME TO keyword_current_summary_swap_old',
    );
    await client.query(
      'ALTER TABLE keyword_current_summary_stage RENAME TO keyword_current_summary',
    );
    await client.query(
      'ALTER TABLE keyword_current_summary_swap_old RENAME TO keyword_current_summary_stage',
    );

    // Update metadata + populate facets atomically with the swap.
    // See migration 0020 (meta) and migration 0021 (snapshot_version,
    // default_severity_total, facets). All readers key by
    // snapshot_version, so a consistent set of (meta, facets) for the
    // new snapshot becomes visible at commit time.
    //
    // - snapshot_version: fresh UUID per refresh, lets caches invalidate
    //   even on a same-week rebuild.
    // - default_severity_total: precomputed COUNT for the default
    //   landing — replaces the cold-slow live count.
    // - facets: per-category counts — replaces the cold-slow
    //   listCategories DISTINCT scan AND the cold-slow per-category
    //   COUNT for category filters.

    // 1. Generate a new snapshot_version + compute the default total.
    //    The COUNT(*) FILTER aggregate runs over the just-swapped
    //    kcs (which has the new data). Pages are warm from the build
    //    we just finished, so it's cheap (~1-3s).
    const { rows: countRows } = await client.query<{ snapshot_version: string; default_severity_total: number }>(
      `SELECT gen_random_uuid()::text AS snapshot_version,
              COUNT(*) FILTER (
                WHERE fake_volume_severity_current IS NULL
                   OR fake_volume_severity_current IN ('none', 'warning')
              )::int AS default_severity_total
       FROM keyword_current_summary`,
    );
    const newSnapshotVersion = countRows[0].snapshot_version;
    const newDefaultTotal = countRows[0].default_severity_total;

    // 2. Insert facets for the new snapshot (both broad category and
    //    Keepa leaf category — same shape, different group-by column).
    await client.query(
      `INSERT INTO keyword_current_summary_category_facets
         (snapshot_version, category, default_severity_count, all_count)
       SELECT
         $1::uuid,
         top_clicked_category_1_current,
         COUNT(*) FILTER (
           WHERE fake_volume_severity_current IS NULL
              OR fake_volume_severity_current IN ('none', 'warning')
         )::int,
         COUNT(*)::int
       FROM keyword_current_summary
       WHERE top_clicked_category_1_current IS NOT NULL
       GROUP BY top_clicked_category_1_current`,
      [newSnapshotVersion],
    );
    await client.query(
      `INSERT INTO keyword_current_summary_leaf_category_facets
         (snapshot_version, leaf_category, default_severity_count, all_count)
       SELECT
         $1::uuid,
         top_clicked_leaf_category,
         COUNT(*) FILTER (
           WHERE fake_volume_severity_current IS NULL
              OR fake_volume_severity_current IN ('none', 'warning')
         )::int,
         COUNT(*)::int
       FROM keyword_current_summary
       WHERE top_clicked_leaf_category IS NOT NULL
       GROUP BY top_clicked_leaf_category`,
      [newSnapshotVersion],
    );

    // 3. Update meta to point at the new snapshot. Also records the
    //    volume-fit info: the run id that produced the snapshot's
    //    estimated_monthly_volume_current values, and whether that fit
    //    was extrapolated. Explorer reads these to render a small
    //    page-level chip.
    await client.query(
      `INSERT INTO keyword_current_summary_meta
         (singleton, current_week_end_date, refreshed_at, snapshot_version,
          default_severity_total, volume_fit_run_id, volume_fit_is_extrapolated)
       VALUES (true, $1::date, now(), $2::uuid, $3::int, $4::uuid, $5::boolean)
       ON CONFLICT (singleton) DO UPDATE
         SET current_week_end_date = EXCLUDED.current_week_end_date,
             refreshed_at = EXCLUDED.refreshed_at,
             snapshot_version = EXCLUDED.snapshot_version,
             default_severity_total = EXCLUDED.default_severity_total,
             volume_fit_run_id = EXCLUDED.volume_fit_run_id,
             volume_fit_is_extrapolated = EXCLUDED.volume_fit_is_extrapolated`,
      [currentWeekEndDate, newSnapshotVersion, newDefaultTotal, chosenFitRunId, chosenIsExtrapolated],
    );

    await client.query('COMMIT');

    // 4. Outside the transaction, clean up facets rows for older
    //    snapshots. Safe to do after commit because nothing depends
    //    on them anymore (meta points at the new snapshot, and any
    //    in-flight readers either see the new snapshot consistently
    //    or briefly see the old facets until their request resolves).
    await client.query(
      'DELETE FROM keyword_current_summary_category_facets WHERE snapshot_version <> $1::uuid',
      [newSnapshotVersion],
    );
    await client.query(
      'DELETE FROM keyword_current_summary_leaf_category_facets WHERE snapshot_version <> $1::uuid',
      [newSnapshotVersion],
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  return {
    rowsWritten,
    durationMs: Date.now() - startedAt,
    currentWeekEndDate: currentWeekEndDate as string,
  };
}

async function stageLatestPerTerm(client: PoolClient): Promise<void> {
  // We pull all 3 product titles + 3 ASIN slots (asin_2 and asin_3 are
  // new in 0029 — needed for Keepa price/review aggregates) + 3 strict
  // flags + 4 loose columns into the temp table. Loose columns are read
  // directly from kwm (which is the source of truth after migration
  // 0016+ and the backfill); kcs no longer recomputes them.
  await client.query(`
    CREATE TEMP TABLE latest_per_term ON COMMIT DROP AS
    WITH ref AS (
      SELECT MAX(week_end_date)::date AS current_week
      FROM reporting_weeks WHERE is_complete = true
    )
    SELECT DISTINCT ON (k.search_term_id)
      k.search_term_id,
      st.search_term_raw,
      k.week_end_date,
      k.actual_rank,
      k.fake_volume_severity,
      k.top_clicked_category_1,
      k.top_clicked_product_1_asin,
      k.top_clicked_product_2_asin,
      k.top_clicked_product_3_asin,
      k.top_clicked_product_1_title,
      k.top_clicked_product_2_title,
      k.top_clicked_product_3_title,
      k.top_clicked_product_1_click_share,
      k.top_clicked_product_1_conversion_share,
      k.keyword_in_title_1,
      k.keyword_in_title_2,
      k.keyword_in_title_3,
      k.keyword_title_match_count,
      k.keyword_in_title_1_loose,
      k.keyword_in_title_2_loose,
      k.keyword_in_title_3_loose,
      k.keyword_title_match_count_loose
    FROM keyword_weekly_metrics k
    JOIN search_terms st ON st.id = k.search_term_id,
    ref
    WHERE k.week_end_date >= ref.current_week - INTERVAL '28 days'
    ORDER BY k.search_term_id, k.week_end_date DESC;
    CREATE INDEX ON latest_per_term (search_term_id);
  `);
}

/**
 * Stage Keepa-enriched data for every ASIN that appears as a top-3
 * clicked product in latest_per_term, scoped to the current week.
 * Pulled into a temp table indexed by ASIN so the main INSERT can
 * LEFT JOIN three times (one per slot) without re-scanning the
 * full asin_weekly_data table for each lookup.
 *
 * Note: we read asin_weekly_data WHERE enrichment_status = 'active'
 * — 'no_price' / 'delisted' / 'error' rows are excluded because their
 * price/review fields are mostly NULL anyway.
 */
async function stageEnrichedAsins(client: PoolClient, currentWeekEndDate: string): Promise<void> {
  await client.query(
    `
    CREATE TEMP TABLE asin_enriched_current ON COMMIT DROP AS
    SELECT
      a.asin,
      a.current_price_cents,
      a.review_count,
      a.average_rating_x10,
      a.category_leaf
    FROM asin_weekly_data a
    WHERE a.week_end_date = $1::date
      AND a.enrichment_status = 'active'
      AND a.asin IN (
        SELECT DISTINCT asin FROM (
          SELECT top_clicked_product_1_asin AS asin FROM latest_per_term WHERE top_clicked_product_1_asin IS NOT NULL
          UNION
          SELECT top_clicked_product_2_asin FROM latest_per_term WHERE top_clicked_product_2_asin IS NOT NULL
          UNION
          SELECT top_clicked_product_3_asin FROM latest_per_term WHERE top_clicked_product_3_asin IS NOT NULL
        ) all_asins
      );
    CREATE INDEX ON asin_enriched_current (asin);
    `,
    [currentWeekEndDate],
  );
}

async function stageRankAtOffset(client: PoolClient, weeksAgo: number): Promise<void> {
  // The "exact week N weeks before each term's current week" is computed
  // by joining latest_per_term to kwm where kwm.week_end_date matches.
  // Output: 1 row per (active term that had data N weeks ago).
  const tableName = `rank_at_${weeksAgo}w`;
  await client.query(
    `
    CREATE TEMP TABLE ${tableName} ON COMMIT DROP AS
    SELECT
      l.search_term_id,
      k.actual_rank
    FROM latest_per_term l
    JOIN keyword_weekly_metrics k
      ON k.search_term_id = l.search_term_id
      AND k.week_end_date = (l.week_end_date - (${weeksAgo} * INTERVAL '7 days'))::date;
    CREATE INDEX ON ${tableName} (search_term_id);
    `,
  );
}

// stageEverTop50k removed — see "ever_top_50k DEFERRED" comment in main flow.
// Will return in Plan 3.5 once we have a faster aggregate strategy.

// stageLooseMatchFlags removed — loose flags are now read directly from
// kwm via latest_per_term. The source of truth is the import-path /
// backfill that populates keyword_in_title_*_loose using the migration
// 0016+ matcher (padded-string + bidirectional plural candidates).
// Recomputing here would (a) duplicate logic, (b) risk drift, and
// (c) waste ~half the refresh wall time.

/**
 * Build a SQL CASE WHEN expression that computes estimated monthly
 * volume from a piecewise (or single-segment) fit, given:
 *   - the fit (segments + breakpoints)
 *   - the SQL column reference for rank (e.g., "l.actual_rank")
 *   - the starting param index ($N) for the bound params
 *
 * Returns the SQL string + the ordered param values to append to
 * the existing pg query args array.
 *
 * For a 4-segment fit with breakpoints [1000, 10000, 100000], the
 * output looks like:
 *
 *   CASE
 *     WHEN l.actual_rank <= $2::int  THEN ($4::numeric  * power(l.actual_rank::numeric, -$3::numeric))::bigint
 *     WHEN l.actual_rank <= $5::int  THEN ($7::numeric  * power(l.actual_rank::numeric, -$6::numeric))::bigint
 *     WHEN l.actual_rank <= $8::int  THEN ($10::numeric * power(l.actual_rank::numeric, -$9::numeric))::bigint
 *     ELSE                                 ($12::numeric * power(l.actual_rank::numeric, -$11::numeric))::bigint
 *   END
 *
 * For a single-segment fit (no breakpoints), it collapses to:
 *   ($3::numeric * power(l.actual_rank::numeric, -$2::numeric))::bigint
 *
 * Params order: for each non-last segment, (breakpoint, β, A). For
 * the last segment, just (β, A) since there's no breakpoint.
 */
function buildPiecewiseSql(
  fit: PiecewiseFit,
  rankCol: string,
  startParamIdx: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let nextIdx = startParamIdx;
  if (fit.segments.length === 0) {
    return { sql: 'NULL::bigint', params: [] };
  }
  if (fit.segments.length === 1) {
    const s = fit.segments[0];
    params.push(s.beta.toFixed(6), s.scaleFactor.toFixed(6));
    const bIdx = nextIdx++;
    const aIdx = nextIdx++;
    return {
      sql: `($${aIdx}::numeric * power(${rankCol}::numeric, -$${bIdx}::numeric))::bigint`,
      params,
    };
  }
  // Piecewise: WHEN clauses for all but the last segment, ELSE for last.
  const whenClauses: string[] = [];
  for (let i = 0; i < fit.segments.length - 1; i++) {
    const seg = fit.segments[i];
    const bp = fit.breakpoints[i];
    params.push(bp, seg.beta.toFixed(6), seg.scaleFactor.toFixed(6));
    const bpIdx = nextIdx++;
    const bIdx = nextIdx++;
    const aIdx = nextIdx++;
    whenClauses.push(
      `WHEN ${rankCol} <= $${bpIdx}::int THEN ($${aIdx}::numeric * power(${rankCol}::numeric, -$${bIdx}::numeric))::bigint`,
    );
  }
  const last = fit.segments[fit.segments.length - 1];
  params.push(last.beta.toFixed(6), last.scaleFactor.toFixed(6));
  const lastBIdx = nextIdx++;
  const lastAIdx = nextIdx++;
  const elseClause = `ELSE ($${lastAIdx}::numeric * power(${rankCol}::numeric, -$${lastBIdx}::numeric))::bigint`;
  return {
    sql: `CASE ${whenClauses.join(' ')} ${elseClause} END`,
    params,
  };
}
