/**
 * Server-side runner for the explorer query. Executes the (sql, args) pair
 * produced by buildExplorerQuery against Neon via the http driver and
 * returns typed rows + total count for the pagination footer.
 *
 * Uses neon-http rather than pg.Pool because:
 * 1. The explorer page runs on Vercel serverless — no long-lived connections
 *    to maintain, and Neon's HTTP transport is the recommended path.
 * 2. The query is short (<1s on indexed kcs reads) so serverless cold-start
 *    penalties don't hurt us.
 *
 * Per-layer perf optimizations active in this file:
 *
 *  - current_week_end_date predicate injection (migration 0020): unlocks
 *    Index Scan on kcs_rank_idx for the rows query.
 *  - default_severity_total short-circuit (migration 0021): the
 *    default landing footer count comes from a precomputed integer on
 *    meta, not a live COUNT(*) over kcs.
 *  - category facets short-circuit (migration 0021): when filters are
 *    "category-only + default severity," count comes from
 *    keyword_current_summary_category_facets, not a live COUNT(*).
 *
 * Each short-circuit has a graceful fallback to the live count if the
 * meta/facets data is missing, so behavior is never broken.
 *
 * The page.tsx server component imports this; raw SQL stays in buildQuery.ts
 * so it remains pure and easy to unit-test.
 */
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { buildExplorerQuery, COUNT_CAP } from './buildQuery';
import type { ExplorerFilters, ExplorerRow, SeverityKey, VolumeFitMeta } from './types';
import { EXPLORER_DEFAULTS } from './parseFilters';

interface ExplorerQueryResult {
  rows: ExplorerRow[];
  total: number;
  /** True when total === COUNT_CAP and the real total may be larger. */
  totalIsCapped: boolean;
  /**
   * Volume-fit metadata for the current snapshot, sourced from the
   * same meta lookup that supplies current_week_end_date. `null` when
   * no fit was selected at refresh time (cold start) — the column
   * just stays empty rather than showing a chip. UI renders a
   * "{Month YYYY} fit" chip and an "extrapolated" warning when set.
   */
  volumeFit: VolumeFitMeta | null;
  /** Per-layer wall-clock timings for the perf instrumentation strip. */
  timings: {
    /** Meta-row lookup that supplies the current_week_end_date predicate. */
    metaLookupMs: number;
    /** Main paged SELECT (LIMIT 100 OFFSET …). */
    rowsMs: number;
    /** Bail-out COUNT(*) with LIMIT 10001, or 0 if skipped via short-circuit. */
    countMs: number;
    /** True if buildExplorerQuery was given a currentWeekEndDate (fast path). */
    usedPredicate: boolean;
    /** Which COUNT path served the total: 'live' (slow), 'meta' (default landing), 'facet' (category-only). */
    countSource: 'live' | 'meta' | 'facet';
  };
}

interface RawRow {
  search_term_id: string;
  search_term_raw: string;
  current_rank: number;
  prior_rank: number | null;
  improvement: number | null;
  top_clicked_category_1_current: string | null;
  fake_volume_severity_current: 'none' | 'warning' | 'critical' | null;
  keyword_title_match_count_current: number | null;
  keyword_in_title_1_current: boolean | null;
  keyword_in_title_2_current: boolean | null;
  keyword_in_title_3_current: boolean | null;
  keyword_title_match_count_loose_current: number | null;
  keyword_in_title_1_loose_current: boolean | null;
  keyword_in_title_2_loose_current: boolean | null;
  keyword_in_title_3_loose_current: boolean | null;
  top_clicked_product_1_asin_current: string | null;
  top_clicked_product_1_title_current: string | null;
  top_clicked_product_1_click_share_current: string | null;
  top_clicked_product_1_conversion_share_current: string | null;
  // bigint comes back as string from pg/neon-http to avoid 53-bit
  // precision loss. Mapper parses to number.
  estimated_monthly_volume_current: string | number | null;
  avg_price_cents: string | number | null;
  avg_reviews: number | null;
  top_clicked_leaf_category: string | null;
}

interface MetaRow {
  current_week_end_date: string | null;
  snapshot_version: string | null;
  default_severity_total: number | null;
  volume_fit_calibration_month_end_date: string | null;
  volume_fit_is_extrapolated: boolean | null;
}

/**
 * Severity defaults match parseFilters.ts EXPLORER_DEFAULTS.severities.
 * The precomputed counts (default_severity_total, default_severity_count
 * on facets) only apply when severities match this exact set.
 */
function isDefaultSeverity(severities: SeverityKey[]): boolean {
  const def = [...EXPLORER_DEFAULTS.severities].sort();
  const cur = [...severities].sort();
  return def.length === cur.length && def.every((s, i) => s === cur[i]);
}

/** True when none of the Keepa-aggregate filters are set. */
function noKeepaFilters(f: ExplorerFilters): boolean {
  return f.leafCategory === null;
}

/**
 * True when the filter set is "default landing": no narrowing filters
 * beyond the default severity. Lets us skip the live COUNT(*) and use
 * the precomputed total on meta.
 */
function canUseDefaultTotal(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category === null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
    && noKeepaFilters(f)
  );
}

/**
 * True when the filter set is "broad-category-only + default severity":
 * exactly one broad category filter, no other narrowing. Lets us use
 * the per-category precomputed count from facets.
 */
function canUseCategoryFacet(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category !== null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
    && noKeepaFilters(f)
  );
}

/**
 * True when the filter set is "leaf-category-only + default severity":
 * exactly one leaf category filter, no broad cat, no other narrowing.
 * Lets us use the precomputed leaf-facet count.
 */
function canUseLeafCategoryFacet(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category === null
    && f.leafCategory !== null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
  );
}

export async function runExplorerQuery(
  filters: ExplorerFilters,
): Promise<ExplorerQueryResult> {
  const sqlClient = neon(env.DATABASE_URL);

  // Fast path setup: one meta lookup gives us everything we need —
  // the current_week_end_date predicate, the snapshot_version (for
  // facet lookups), the default_severity_total (for landing-page
  // count short-circuit), and the volume-fit info (for the page
  // chip).
  let currentWeekEndDate: string | undefined;
  let snapshotVersion: string | undefined;
  let defaultSeverityTotal: number | undefined;
  let volumeFit: VolumeFitMeta | null = null;
  const tMetaStart = Date.now();
  try {
    const metaRows = (await sqlClient`
      SELECT
        m.current_week_end_date::text AS current_week_end_date,
        m.snapshot_version::text       AS snapshot_version,
        m.default_severity_total       AS default_severity_total,
        r.calibration_month_end_date::text AS volume_fit_calibration_month_end_date,
        m.volume_fit_is_extrapolated   AS volume_fit_is_extrapolated
      FROM keyword_current_summary_meta m
      LEFT JOIN model_calibration_runs r ON r.id = m.volume_fit_run_id
      WHERE m.singleton = true
    `) as MetaRow[];
    const meta = metaRows[0];
    currentWeekEndDate = meta?.current_week_end_date ?? undefined;
    snapshotVersion = meta?.snapshot_version ?? undefined;
    defaultSeverityTotal = meta?.default_severity_total ?? undefined;
    if (meta?.volume_fit_calibration_month_end_date) {
      volumeFit = {
        calibrationMonthEndDate: meta.volume_fit_calibration_month_end_date,
        isExtrapolated: meta.volume_fit_is_extrapolated ?? false,
      };
    }
  } catch {
    // Fallthrough: everything stays undefined, queries use legacy paths.
  }
  const metaLookupMs = Date.now() - tMetaStart;

  const { sql, args, countSql, countArgs } = buildExplorerQuery(filters, currentWeekEndDate);

  // Decide whether to short-circuit the count.
  let countSource: 'live' | 'meta' | 'facet' = 'live';
  let precomputedTotal: number | null = null;

  if (canUseDefaultTotal(filters) && defaultSeverityTotal !== undefined) {
    precomputedTotal = defaultSeverityTotal;
    countSource = 'meta';
  } else if (canUseCategoryFacet(filters) && snapshotVersion) {
    try {
      const facetRows = (await sqlClient`
        SELECT default_severity_count AS n
        FROM keyword_current_summary_category_facets
        WHERE snapshot_version = ${snapshotVersion}::uuid
          AND category = ${filters.category}
      `) as Array<{ n: number }>;
      if (facetRows.length > 0) {
        precomputedTotal = facetRows[0].n;
        countSource = 'facet';
      }
    } catch {
      // Fall through to live count
    }
  } else if (canUseLeafCategoryFacet(filters) && snapshotVersion) {
    try {
      const facetRows = (await sqlClient`
        SELECT default_severity_count AS n
        FROM keyword_current_summary_leaf_category_facets
        WHERE snapshot_version = ${snapshotVersion}::uuid
          AND leaf_category = ${filters.leafCategory}
      `) as Array<{ n: number }>;
      if (facetRows.length > 0) {
        precomputedTotal = facetRows[0].n;
        countSource = 'facet';
      }
    } catch {
      // Fall through to live count
    }
  }

  // Run rows query (always live) and count query (only if not short-circuited)
  // in parallel. Both timings captured.
  const tRowsStart = Date.now();
  const rowsPromise = sqlClient.query(sql, args).then((r) => {
    return { result: r, ms: Date.now() - tRowsStart };
  });

  const tCountStart = Date.now();
  const countPromise = precomputedTotal !== null
    ? Promise.resolve({ result: null as unknown, ms: 0 })
    : sqlClient.query(countSql, countArgs).then((r) => {
        return { result: r, ms: Date.now() - tCountStart };
      });

  const [rowsTimed, countTimed] = await Promise.all([rowsPromise, countPromise]);
  const rawRowsAny = rowsTimed.result;
  const rawRows = rawRowsAny as unknown as RawRow[];

  const rows: ExplorerRow[] = rawRows.map((r) => ({
    searchTermId: r.search_term_id,
    searchTermRaw: r.search_term_raw,
    currentRank: r.current_rank,
    priorRank: r.prior_rank,
    improvement: r.improvement,
    topClickedCategory1: r.top_clicked_category_1_current,
    fakeVolumeSeverity: r.fake_volume_severity_current,
    keywordTitleMatchCount: r.keyword_title_match_count_current,
    keywordInTitle1: r.keyword_in_title_1_current,
    keywordInTitle2: r.keyword_in_title_2_current,
    keywordInTitle3: r.keyword_in_title_3_current,
    keywordTitleMatchCountLoose: r.keyword_title_match_count_loose_current,
    keywordInTitle1Loose: r.keyword_in_title_1_loose_current,
    keywordInTitle2Loose: r.keyword_in_title_2_loose_current,
    keywordInTitle3Loose: r.keyword_in_title_3_loose_current,
    topClickedProduct1Asin: r.top_clicked_product_1_asin_current,
    topClickedProduct1Title: r.top_clicked_product_1_title_current,
    topClickedProduct1ClickShare: r.top_clicked_product_1_click_share_current,
    topClickedProduct1ConversionShare: r.top_clicked_product_1_conversion_share_current,
    estimatedMonthlyVolumeCurrent: parseBigint(r.estimated_monthly_volume_current),
    avgPriceCents: parseBigint(r.avg_price_cents),
    avgReviews: r.avg_reviews ?? null,
    topClickedLeafCategory: r.top_clicked_leaf_category ?? null,
  }));

  // Final total: precomputed wins; otherwise extract from live count
  // (capped via the COUNT_CAP+1 bail-out).
  let total: number;
  let totalIsCapped: boolean;
  if (precomputedTotal !== null) {
    totalIsCapped = precomputedTotal > COUNT_CAP;
    total = totalIsCapped ? COUNT_CAP : precomputedTotal;
  } else {
    const countRowsAny = countTimed.result;
    const countRows = countRowsAny as unknown as Array<{ total: number | string }>;
    const rawTotal = countRows && countRows.length > 0
      ? typeof countRows[0].total === 'string'
        ? parseInt(countRows[0].total, 10)
        : countRows[0].total
      : 0;
    totalIsCapped = rawTotal > COUNT_CAP;
    total = totalIsCapped ? COUNT_CAP : rawTotal;
  }

  return {
    rows,
    total,
    totalIsCapped,
    volumeFit,
    timings: {
      metaLookupMs,
      rowsMs: rowsTimed.ms,
      countMs: countTimed.ms,
      usedPredicate: currentWeekEndDate !== undefined,
      countSource,
    },
  };
}

/**
 * Postgres bigint columns come back as strings from pg/neon-http to
 * preserve full 64-bit precision. For the volume / price columns we
 * top out well under 2^53, so parseInt is safe.
 */
function parseBigint(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? parseInt(v, 10) : v;
}
