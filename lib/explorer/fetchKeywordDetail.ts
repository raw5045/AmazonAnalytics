/**
 * Server-side data fetcher for the /explorer/keyword/<id> page.
 *
 * Exports three loaders:
 *   - fetchKeywordChartData(id)  — FAST: reads keyword_chart_series (compact)
 *       plus search_terms, kcs current, fits, current-week kwm (for product
 *       ASINs/titles + variants). Falls back to a full kwm 52-week read when
 *       the series row is absent or the table doesn't exist yet.
 *   - fetchKeywordRawHistory(id) — SLOW: full 52-week kwm scan for the
 *       "Weekly history" raw table, streamed behind <Suspense>.
 *   - fetchKeywordDetail(id)     — legacy single loader; kept for any other
 *       callers; composes the two functions above.
 *
 * Both hit existing indexes (kcs PK on search_term_id, kwm_term_week_idx).
 */
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import type { SeverityKey } from './types';
import { pickFitForWeek, predictVolumeFromFit, type FitParams } from '@/lib/analytics/volumeModel';
import type { FitParamsJson } from '@/db/schema/modelCalibrationRuns';
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';
import { seriesToHistoryRows } from './chartSeries';

export interface KeywordDetailHistoryRow {
  weekEndDate: string;
  actualRank: number;
  topClickedProduct1Asin: string | null;
  topClickedProduct1Title: string | null;
  topClickedProduct1ClickShare: string | null;
  topClickedProduct1ConversionShare: string | null;
  topClickedProduct2Asin: string | null;
  topClickedProduct2Title: string | null;
  topClickedProduct3Asin: string | null;
  topClickedProduct3Title: string | null;
  topClickedCategory1: string | null;
  keywordInTitle1: boolean | null;
  keywordInTitle2: boolean | null;
  keywordInTitle3: boolean | null;
  keywordTitleMatchCount: number | null;
  // Loose match flags (per-week) — backfilled in migration 0014.
  // NULL only on rows not yet backfilled (transitional).
  keywordInTitle1Loose: boolean | null;
  keywordInTitle2Loose: boolean | null;
  keywordInTitle3Loose: boolean | null;
  keywordTitleMatchCountLoose: number | null;
  fakeVolumeSeverity: SeverityKey | null;
  fakeVolumeEvalStatus: string | null;
  /**
   * Estimated monthly Amazon search volume for THIS week, derived
   * at fetch time from the fit selected by pickFitForWeek for this
   * specific week's month. NULL when no fits exist at all.
   */
  estimatedMonthlyVolume: number | null;
  /**
   * True when the fit used for this week's volume was selected via
   * the earliest-fit-with-extrapolation fallback (the week predates
   * all calibration runs). UI shows a tooltip.
   */
  estimatedMonthlyVolumeIsExtrapolated: boolean;
  // Variant info from import_duplicate_search_terms — populated when
  // Amazon's CSV had multiple rows for this (week, normalized term).
  // null when no variants existed for this week (the common case).
  variants: KeywordVariantInfo | null;
}

export interface KeywordVariantInfo {
  /** How many rows existed in the source CSV. Always >= 2 when present. */
  duplicateCount: number;
  /** All ranks from the source CSV (sorted asc; first is the kept rank). */
  losingRanks: number[];
  /** Up to 3 example raw values from the source CSV. */
  rawExamples: string[];
}

/**
 * Keepa-enriched product data for one of the top-3 ASINs on the keyword
 * detail page. Sourced from `asin_weekly_data` at the keyword's current
 * week. `null` when the ASIN isn't yet enriched (e.g. dormant keyword,
 * or an ASIN that was excluded from enrichment scope).
 */
export interface EnrichedProduct {
  asin: string;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  categoryPath: string | null;
  categoryRoot: string | null;
  categoryLeaf: string | null;
  currentPriceCents: number | null;
  salesRank: number | null;
  reviewCount: number | null;
  /** 0-50 scale (divide by 10 to display as 0.0-5.0 stars). */
  averageRatingX10: number | null;
  avg30PriceCents: number | null;
  avg90PriceCents: number | null;
  avg180PriceCents: number | null;
  avg365PriceCents: number | null;
  enrichmentStatus: 'active' | 'no_price' | 'delisted' | 'error';
}

export interface KeywordDetailCurrent {
  currentWeekEndDate: string;
  currentRank: number;
  priorWeekRank: number | null;
  improvement1w: number | null;
  fakeVolumeSeverityCurrent: SeverityKey | null;
  topClickedProduct1AsinCurrent: string | null;
  topClickedProduct1TitleCurrent: string | null;
  topClickedProduct1ClickShareCurrent: string | null;
  topClickedProduct1ConversionShareCurrent: string | null;
  // Loose match (computed by us)
  keywordInTitle1LooseCurrent: boolean | null;
  keywordInTitle2LooseCurrent: boolean | null;
  keywordInTitle3LooseCurrent: boolean | null;
  keywordTitleMatchCountLooseCurrent: number | null;
  /**
   * Estimated current monthly search volume. Computed from
   * the fit picked for current_week_end_date (or the precomputed kcs
   * value when it matches). Null when no fits exist at all.
   */
  estimatedMonthlyVolumeCurrent: number | null;
  /** True when the chosen fit is extrapolated (see VolumeFitMeta). */
  estimatedMonthlyVolumeIsExtrapolated: boolean;
}

export interface KeywordDetail {
  searchTermId: string;
  searchTermRaw: string;
  searchTermNormalized: string;
  /** First/last week the term has appeared in any imported CSV. */
  firstSeenWeek: string;
  lastSeenWeek: string;
  /**
   * The kcs row. Null when the term is "dormant" (last seen >28 days ago,
   * so it's been pruned from kcs by the refresh's active filter). The
   * page handles null by rendering a "this keyword is dormant" banner.
   */
  current: KeywordDetailCurrent | null;
  /** Up to 52 rows, oldest first. (Page renderer reverses for display.) */
  history: KeywordDetailHistoryRow[];
  /**
   * Keepa-enriched product data for the top-3 ASINs at the current week,
   * keyed by ASIN. Empty when the keyword is dormant (no current week) or
   * when none of the top-3 ASINs have been enriched yet (e.g. ASINs in
   * the excluded-category scope).
   */
  enrichedProductsByAsin: Record<string, EnrichedProduct>;
}

/**
 * One top-clicked product slot from the current week's kwm row.
 * Used by the fast loader to supply product ASINs/titles for the
 * TopProductsTable without needing the full history.
 */
export interface CurrentWeekProductSlot {
  slot: 1 | 2 | 3;
  asin: string | null;
  title: string | null;
}

/**
 * Return type of fetchKeywordChartData — everything the detail page
 * needs to render its header, charts, top-products box, and variants
 * box. The raw "Weekly history" table is NOT included; it streams in
 * separately via fetchKeywordRawHistory.
 */
export interface KeywordChartData {
  searchTermId: string;
  searchTermRaw: string;
  searchTermNormalized: string;
  firstSeenWeek: string;
  lastSeenWeek: string;
  current: KeywordDetailCurrent | null;
  /**
   * History rows derived from keyword_chart_series (fast path) or from
   * a kwm 52-week read (fallback). Used by all 4 charts.
   */
  chartHistory: KeywordDetailHistoryRow[];
  enrichedProductsByAsin: Record<string, EnrichedProduct>;
  /**
   * The top-3 ASINs + titles from kwm for the current week.
   * Used to populate TopProductsTable (slots 2 & 3 aren't in kcs).
   * Empty array for dormant keywords.
   */
  currentWeekProductSlots: CurrentWeekProductSlot[];
  /**
   * Variant info for the current week, sourced from
   * import_duplicate_search_terms. Null when no duplicates for that week
   * or keyword is dormant.
   */
  currentWeekVariants: KeywordVariantInfo | null;
}

/**
 * Returns null when the search_term doesn't exist (404 case for the page).
 */
export async function fetchKeywordDetail(
  searchTermId: string,
): Promise<KeywordDetail | null> {
  const sql = neon(env.DATABASE_URL);

  const [termRowsAny, currentRowsAny, historyRowsAny, variantRowsAny, enrichedRowsAny, fitRowsAny] = await Promise.all([
    sql`
      SELECT id, search_term_raw, search_term_normalized,
             first_seen_week, last_seen_week
      FROM search_terms
      WHERE id = ${searchTermId}
    `,
    sql`
      SELECT
        current_week_end_date,
        current_rank,
        prior_week_rank,
        improvement_1w,
        -- Defensive: apply the same rank > 100k mask as for history.
        -- The kcs row should already reflect this rule (after the
        -- one-shot fixKcs script + future refresh logic), but masking
        -- at read time means correctness doesn't depend on operational
        -- ordering.
        CASE
          WHEN current_rank > 100000 THEN 'none'::fake_volume_severity
          ELSE fake_volume_severity_current
        END AS fake_volume_severity_current,
        top_clicked_product_1_asin_current,
        top_clicked_product_1_title_current,
        top_clicked_product_1_click_share_current,
        top_clicked_product_1_conversion_share_current,
        keyword_in_title_1_loose_current,
        keyword_in_title_2_loose_current,
        keyword_in_title_3_loose_current,
        keyword_title_match_count_loose_current
      FROM keyword_current_summary
      WHERE search_term_id = ${searchTermId}
    `,
    sql`
      SELECT
        week_end_date,
        actual_rank,
        top_clicked_product_1_asin,
        top_clicked_product_1_title,
        top_clicked_product_1_click_share,
        top_clicked_product_1_conversion_share,
        top_clicked_product_2_asin,
        top_clicked_product_2_title,
        top_clicked_product_3_asin,
        top_clicked_product_3_title,
        top_clicked_category_1,
        keyword_in_title_1,
        keyword_in_title_2,
        keyword_in_title_3,
        keyword_title_match_count,
        keyword_in_title_1_loose,
        keyword_in_title_2_loose,
        keyword_in_title_3_loose,
        keyword_title_match_count_loose,
        -- Apply the rank > 100,000 threshold mask at read time: at low
        -- volume the click_share/conversion_share signals that drive
        -- severity are too noisy to be meaningful. Raw value stays in
        -- kwm (no historical backfill needed); we just mask on read.
        -- See inngest/functions/importFile.ts FAKE_VOLUME_RANK_THRESHOLD
        -- for the equivalent forward-going rule applied at insert time.
        CASE
          WHEN actual_rank > 100000 THEN 'none'::fake_volume_severity
          ELSE fake_volume_severity
        END AS fake_volume_severity,
        CASE
          WHEN actual_rank > 100000 THEN 'rank_below_threshold'::fake_volume_eval_status
          ELSE fake_volume_eval_status
        END AS fake_volume_eval_status
      FROM (
        -- Cap history at the most-recent 52 weeks. As more weeks
        -- accumulate over time, the RawDataTable would otherwise grow
        -- unbounded; capping here also matches the 52-week windows
        -- used by RankChart / TitleMatchHistory / FakeVolumeStrip.
        SELECT *
        FROM keyword_weekly_metrics
        WHERE search_term_id = ${searchTermId}
        ORDER BY week_end_date DESC
        LIMIT 52
      ) kwm_recent
      ORDER BY week_end_date ASC
    `,
    sql`
      SELECT week_end_date, duplicate_count, losing_ranks, raw_examples
      FROM import_duplicate_search_terms
      WHERE search_term_id = ${searchTermId}
    `,
    // Keepa-enriched data for the top-3 ASINs at the current week. The
    // JOIN narrows asin_weekly_data to (week = kcs.current_week,
    // asin IN [top_1, top_2, top_3]) — at most 3 rows. Returns 0 rows
    // for dormant keywords (no kcs row) or ones whose top-3 ASINs fall
    // outside the enrichment scope (excluded category / rank > 100K).
    sql`
      SELECT
        a.asin, a.title, a.brand, a.image_url,
        a.category_path, a.category_root, a.category_leaf,
        a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10,
        a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
        a.enrichment_status::text AS enrichment_status
      FROM asin_weekly_data a
      JOIN keyword_current_summary kcs
        ON kcs.search_term_id = ${searchTermId}
      JOIN keyword_weekly_metrics kwm
        ON kwm.search_term_id = kcs.search_term_id
        AND kwm.week_end_date = kcs.current_week_end_date
      WHERE a.week_end_date = kcs.current_week_end_date
        AND a.asin = ANY(ARRAY[
          kwm.top_clicked_product_1_asin,
          kwm.top_clicked_product_2_asin,
          kwm.top_clicked_product_3_asin
        ]::text[])
    `,
    // All calibration fits — used to compute per-week estimated volume.
    // Cardinality is small (a handful of monthly fits over the app's
    // lifetime), so fetching all and picking per-row in JS is cheaper
    // than a per-row SQL join. fit_params is the full piecewise
    // structure when present; legacy rows fall back to (beta,
    // scale_factor) as a single segment.
    sql`
      SELECT
        id,
        calibration_month_end_date::text AS calibration_month_end_date,
        fitted_at::text                  AS fitted_at,
        beta::text                       AS beta,
        scale_factor::text               AS scale_factor,
        fit_params                       AS fit_params
      FROM model_calibration_runs
    `,
  ]);
  const termRows = termRowsAny as unknown as Array<{
    id: string;
    search_term_raw: string;
    search_term_normalized: string;
    first_seen_week: string;
    last_seen_week: string;
  }>;
  const currentRows = currentRowsAny as unknown as Array<Record<string, unknown>>;
  const historyRows = historyRowsAny as unknown as Array<Record<string, unknown>>;
  const variantRows = variantRowsAny as unknown as Array<{
    week_end_date: string;
    duplicate_count: number;
    losing_ranks: number[];
    raw_examples: string[];
  }>;
  const enrichedRows = enrichedRowsAny as unknown as Array<Record<string, unknown>>;
  const fitRows = fitRowsAny as unknown as Array<{
    id: string;
    calibration_month_end_date: string;
    fitted_at: string;
    beta: string;
    scale_factor: string;
    fit_params: FitParamsJson | null;
  }>;
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

  if (termRows.length === 0) return null;
  const term = termRows[0];

  const current: KeywordDetailCurrent | null = currentRows.length > 0
    ? mapCurrent(currentRows[0], fits)
    : null;

  // Index variants by week for O(1) lookup during history mapping.
  const variantsByWeek = new Map<string, KeywordVariantInfo>();
  for (const v of variantRows) {
    variantsByWeek.set(toIsoDate(v.week_end_date), {
      duplicateCount: v.duplicate_count,
      losingRanks: v.losing_ranks ?? [],
      rawExamples: v.raw_examples ?? [],
    });
  }

  // Map enriched products by ASIN for O(1) lookup at render time.
  const enrichedProductsByAsin = mapEnrichedProducts(enrichedRows);

  return {
    searchTermId: term.id,
    searchTermRaw: term.search_term_raw,
    searchTermNormalized: term.search_term_normalized,
    firstSeenWeek: toIsoDate(term.first_seen_week),
    lastSeenWeek: toIsoDate(term.last_seen_week),
    current,
    history: historyRows.map((r) => mapHistory(r, variantsByWeek, fits)),
    enrichedProductsByAsin,
  };
}

function mapEnrichedProducts(
  rows: Array<Record<string, unknown>>,
): Record<string, EnrichedProduct> {
  const result: Record<string, EnrichedProduct> = {};
  for (const r of rows) {
    const asin = r.asin as string;
    result[asin] = {
      asin,
      title: (r.title as string | null) ?? null,
      brand: (r.brand as string | null) ?? null,
      imageUrl: (r.image_url as string | null) ?? null,
      categoryPath: (r.category_path as string | null) ?? null,
      categoryRoot: (r.category_root as string | null) ?? null,
      categoryLeaf: (r.category_leaf as string | null) ?? null,
      currentPriceCents: (r.current_price_cents as number | null) ?? null,
      salesRank: (r.sales_rank as number | null) ?? null,
      reviewCount: (r.review_count as number | null) ?? null,
      averageRatingX10: (r.average_rating_x10 as number | null) ?? null,
      avg30PriceCents: (r.avg30_price_cents as number | null) ?? null,
      avg90PriceCents: (r.avg90_price_cents as number | null) ?? null,
      avg180PriceCents: (r.avg180_price_cents as number | null) ?? null,
      avg365PriceCents: (r.avg365_price_cents as number | null) ?? null,
      enrichmentStatus: r.enrichment_status as EnrichedProduct['enrichmentStatus'],
    };
  }
  return result;
}

function mapCurrent(r: Record<string, unknown>, fits: ReadonlyArray<FitParams>): KeywordDetailCurrent {
  const currentWeekEndDate = toIsoDate(r.current_week_end_date as string);
  const currentRank = r.current_rank as number;
  const sel = pickFitForWeek(currentWeekEndDate, fits);
  const estVol = sel ? Math.round(predictVolumeFromFit(currentRank, sel.fit)) : null;
  return {
    currentWeekEndDate,
    currentRank,
    priorWeekRank: (r.prior_week_rank as number | null) ?? null,
    improvement1w: (r.improvement_1w as number | null) ?? null,
    fakeVolumeSeverityCurrent: (r.fake_volume_severity_current as SeverityKey | null) ?? null,
    topClickedProduct1AsinCurrent: (r.top_clicked_product_1_asin_current as string | null) ?? null,
    topClickedProduct1TitleCurrent: (r.top_clicked_product_1_title_current as string | null) ?? null,
    topClickedProduct1ClickShareCurrent: (r.top_clicked_product_1_click_share_current as string | null) ?? null,
    topClickedProduct1ConversionShareCurrent: (r.top_clicked_product_1_conversion_share_current as string | null) ?? null,
    keywordInTitle1LooseCurrent: (r.keyword_in_title_1_loose_current as boolean | null) ?? null,
    keywordInTitle2LooseCurrent: (r.keyword_in_title_2_loose_current as boolean | null) ?? null,
    keywordInTitle3LooseCurrent: (r.keyword_in_title_3_loose_current as boolean | null) ?? null,
    keywordTitleMatchCountLooseCurrent: (r.keyword_title_match_count_loose_current as number | null) ?? null,
    estimatedMonthlyVolumeCurrent: estVol,
    estimatedMonthlyVolumeIsExtrapolated: sel?.isExtrapolated ?? false,
  };
}

function mapHistory(
  r: Record<string, unknown>,
  variantsByWeek: Map<string, KeywordVariantInfo>,
  fits: ReadonlyArray<FitParams>,
): KeywordDetailHistoryRow {
  const weekEndDate = toIsoDate(r.week_end_date as string);
  const actualRank = r.actual_rank as number;
  // Each history row picks its OWN fit — different weeks land in
  // different calibration months. Math.pow over ~52 rows is microseconds;
  // no need to batch.
  const sel = pickFitForWeek(weekEndDate, fits);
  const estVol = sel ? Math.round(predictVolumeFromFit(actualRank, sel.fit)) : null;
  return {
    weekEndDate,
    actualRank,
    topClickedProduct1Asin: (r.top_clicked_product_1_asin as string | null) ?? null,
    topClickedProduct1Title: (r.top_clicked_product_1_title as string | null) ?? null,
    topClickedProduct1ClickShare: (r.top_clicked_product_1_click_share as string | null) ?? null,
    topClickedProduct1ConversionShare: (r.top_clicked_product_1_conversion_share as string | null) ?? null,
    topClickedProduct2Asin: (r.top_clicked_product_2_asin as string | null) ?? null,
    topClickedProduct2Title: (r.top_clicked_product_2_title as string | null) ?? null,
    topClickedProduct3Asin: (r.top_clicked_product_3_asin as string | null) ?? null,
    topClickedProduct3Title: (r.top_clicked_product_3_title as string | null) ?? null,
    topClickedCategory1: (r.top_clicked_category_1 as string | null) ?? null,
    keywordInTitle1: (r.keyword_in_title_1 as boolean | null) ?? null,
    keywordInTitle2: (r.keyword_in_title_2 as boolean | null) ?? null,
    keywordInTitle3: (r.keyword_in_title_3 as boolean | null) ?? null,
    keywordTitleMatchCount: (r.keyword_title_match_count as number | null) ?? null,
    keywordInTitle1Loose: (r.keyword_in_title_1_loose as boolean | null) ?? null,
    keywordInTitle2Loose: (r.keyword_in_title_2_loose as boolean | null) ?? null,
    keywordInTitle3Loose: (r.keyword_in_title_3_loose as boolean | null) ?? null,
    keywordTitleMatchCountLoose: (r.keyword_title_match_count_loose as number | null) ?? null,
    fakeVolumeSeverity: (r.fake_volume_severity as SeverityKey | null) ?? null,
    fakeVolumeEvalStatus: (r.fake_volume_eval_status as string | null) ?? null,
    estimatedMonthlyVolume: estVol,
    estimatedMonthlyVolumeIsExtrapolated: sel?.isExtrapolated ?? false,
    variants: variantsByWeek.get(weekEndDate) ?? null,
  };
}

/**
 * Postgres returns date columns as `YYYY-MM-DD` strings (under neon-http) or
 * `Date` objects in some configurations. Normalize to `YYYY-MM-DD` for stable
 * client-side rendering.
 */
function toIsoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Trim a possible trailing time portion if any driver returns ISO with time.
  return String(value).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Shared raw-SQL helpers
// ---------------------------------------------------------------------------

/** Fetch all calibration fits from model_calibration_runs. */
async function fetchFits(dbUrl: string): Promise<FitParams[]> {
  const sql = neon(dbUrl);
  const fitRowsAny = await sql`
    SELECT
      id,
      calibration_month_end_date::text AS calibration_month_end_date,
      fitted_at::text                  AS fitted_at,
      beta::text                       AS beta,
      scale_factor::text               AS scale_factor,
      fit_params                       AS fit_params
    FROM model_calibration_runs
  `;
  const fitRows = fitRowsAny as unknown as Array<{
    id: string;
    calibration_month_end_date: string;
    fitted_at: string;
    beta: string;
    scale_factor: string;
    fit_params: FitParamsJson | null;
  }>;
  return fitRows.map((r) => {
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
}

/**
 * Full 52-week kwm scan — the slow query (~60 s cold). Shared between
 * fetchKeywordRawHistory and the fallback path inside fetchKeywordChartData.
 */
async function fetchKwmHistory(
  dbUrl: string,
  searchTermId: string,
): Promise<Array<Record<string, unknown>>> {
  const sql = neon(dbUrl);
  const rows = await sql`
    SELECT
      week_end_date,
      actual_rank,
      top_clicked_product_1_asin,
      top_clicked_product_1_title,
      top_clicked_product_1_click_share,
      top_clicked_product_1_conversion_share,
      top_clicked_product_2_asin,
      top_clicked_product_2_title,
      top_clicked_product_3_asin,
      top_clicked_product_3_title,
      top_clicked_category_1,
      keyword_in_title_1,
      keyword_in_title_2,
      keyword_in_title_3,
      keyword_title_match_count,
      keyword_in_title_1_loose,
      keyword_in_title_2_loose,
      keyword_in_title_3_loose,
      keyword_title_match_count_loose,
      CASE
        WHEN actual_rank > 100000 THEN 'none'::fake_volume_severity
        ELSE fake_volume_severity
      END AS fake_volume_severity,
      CASE
        WHEN actual_rank > 100000 THEN 'rank_below_threshold'::fake_volume_eval_status
        ELSE fake_volume_eval_status
      END AS fake_volume_eval_status
    FROM (
      SELECT *
      FROM keyword_weekly_metrics
      WHERE search_term_id = ${searchTermId}
      ORDER BY week_end_date DESC
      LIMIT 52
    ) kwm_recent
    ORDER BY week_end_date ASC
  `;
  return rows as unknown as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// fetchKeywordChartData — FAST loader for the detail-page header + charts
// ---------------------------------------------------------------------------

/**
 * Fast loader: reads keyword_chart_series for chart history (single row),
 * plus a targeted current-week kwm read for product ASINs/titles and
 * variant info. Falls back to a full kwm scan when the series row is absent
 * or the table doesn't yet exist.
 *
 * Returns null when the search_term doesn't exist (→ 404).
 */
export async function fetchKeywordChartData(
  searchTermId: string,
): Promise<KeywordChartData | null> {
  const dbUrl = env.DATABASE_URL;
  const sql = neon(dbUrl);

  // Run term, current, fits, and enriched products in parallel.
  // We also attempt to read the series row; if the table is absent we catch
  // and fall back. The current-week kwm slice (for product slots + variants)
  // needs kcs.current_week_end_date, so it runs after the current query.
  const [termRowsAny, currentRowsAny, fitsResult, seriesResult] = await Promise.all([
    sql`
      SELECT id, search_term_raw, search_term_normalized,
             first_seen_week, last_seen_week
      FROM search_terms
      WHERE id = ${searchTermId}
    `,
    sql`
      SELECT
        current_week_end_date,
        current_rank,
        prior_week_rank,
        improvement_1w,
        CASE
          WHEN current_rank > 100000 THEN 'none'::fake_volume_severity
          ELSE fake_volume_severity_current
        END AS fake_volume_severity_current,
        top_clicked_product_1_asin_current,
        top_clicked_product_1_title_current,
        top_clicked_product_1_click_share_current,
        top_clicked_product_1_conversion_share_current,
        keyword_in_title_1_loose_current,
        keyword_in_title_2_loose_current,
        keyword_in_title_3_loose_current,
        keyword_title_match_count_loose_current
      FROM keyword_current_summary
      WHERE search_term_id = ${searchTermId}
    `,
    fetchFits(dbUrl),
    // Series read: catch "relation does not exist" (table not yet migrated)
    // and treat as no series → fallback.
    sql`
      SELECT series
      FROM keyword_chart_series
      WHERE search_term_id = ${searchTermId}
    `.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('relation') && msg.includes('does not exist')) return [];
      throw err;
    }),
  ]);

  const termRows = termRowsAny as unknown as Array<{
    id: string;
    search_term_raw: string;
    search_term_normalized: string;
    first_seen_week: string;
    last_seen_week: string;
  }>;

  if (termRows.length === 0) return null;
  const term = termRows[0];

  const currentRowsRaw = currentRowsAny as unknown as Array<Record<string, unknown>>;
  const fits = fitsResult;
  const seriesRows = seriesResult as unknown as Array<{ series: ChartSeriesEntry[] }>;

  const current: KeywordDetailCurrent | null =
    currentRowsRaw.length > 0 ? mapCurrent(currentRowsRaw[0], fits) : null;

  // Current week: run current-week kwm slice and variants in parallel.
  // Only needed when the keyword is active (has a current kcs row).
  let currentWeekProductSlots: CurrentWeekProductSlot[] = [];
  let currentWeekVariants: KeywordVariantInfo | null = null;

  if (current) {
    const [currentWeekKwmAny, variantRowsAny] = await Promise.all([
      // Targeted single-row kwm read for the current week — gives us the
      // top-3 ASINs + titles that the series doesn't store.
      sql`
        SELECT
          top_clicked_product_1_asin,
          top_clicked_product_1_title,
          top_clicked_product_2_asin,
          top_clicked_product_2_title,
          top_clicked_product_3_asin,
          top_clicked_product_3_title
        FROM keyword_weekly_metrics
        WHERE search_term_id = ${searchTermId}
          AND week_end_date = ${current.currentWeekEndDate}
        LIMIT 1
      `,
      // Variant info for the current week only (the box only shows current).
      sql`
        SELECT duplicate_count, losing_ranks, raw_examples
        FROM import_duplicate_search_terms
        WHERE search_term_id = ${searchTermId}
          AND week_end_date = ${current.currentWeekEndDate}
        LIMIT 1
      `,
    ]);

    const kwmRow = (currentWeekKwmAny as unknown as Array<Record<string, unknown>>)[0];
    if (kwmRow) {
      currentWeekProductSlots = [
        { slot: 1, asin: (kwmRow.top_clicked_product_1_asin as string | null) ?? null, title: (kwmRow.top_clicked_product_1_title as string | null) ?? null },
        { slot: 2, asin: (kwmRow.top_clicked_product_2_asin as string | null) ?? null, title: (kwmRow.top_clicked_product_2_title as string | null) ?? null },
        { slot: 3, asin: (kwmRow.top_clicked_product_3_asin as string | null) ?? null, title: (kwmRow.top_clicked_product_3_title as string | null) ?? null },
      ];
    }

    const variantRow = (variantRowsAny as unknown as Array<{
      duplicate_count: number;
      losing_ranks: number[];
      raw_examples: string[];
    }>)[0];
    if (variantRow) {
      currentWeekVariants = {
        duplicateCount: variantRow.duplicate_count,
        losingRanks: variantRow.losing_ranks ?? [],
        rawExamples: variantRow.raw_examples ?? [],
      };
    }
  }

  // Run the enriched-products query in parallel with the current-week queries
  // (it also needs current_week_end_date, which requires the current row).
  let enrichedProductsByAsin: Record<string, EnrichedProduct> = {};
  if (current) {
    const enrichedRowsAny = await sql`
      SELECT
        a.asin, a.title, a.brand, a.image_url,
        a.category_path, a.category_root, a.category_leaf,
        a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10,
        a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
        a.enrichment_status::text AS enrichment_status
      FROM asin_weekly_data a
      JOIN keyword_current_summary kcs
        ON kcs.search_term_id = ${searchTermId}
      JOIN keyword_weekly_metrics kwm
        ON kwm.search_term_id = kcs.search_term_id
        AND kwm.week_end_date = kcs.current_week_end_date
      WHERE a.week_end_date = kcs.current_week_end_date
        AND a.asin = ANY(ARRAY[
          kwm.top_clicked_product_1_asin,
          kwm.top_clicked_product_2_asin,
          kwm.top_clicked_product_3_asin
        ]::text[])
    `;
    enrichedProductsByAsin = mapEnrichedProducts(
      enrichedRowsAny as unknown as Array<Record<string, unknown>>,
    );
  }

  // Determine chartHistory: series fast path or kwm fallback.
  let chartHistory: KeywordDetailHistoryRow[];
  if (seriesRows.length > 0 && seriesRows[0].series?.length > 0) {
    chartHistory = seriesToHistoryRows(seriesRows[0].series, fits);
  } else {
    // Fallback: full kwm scan (same as before; correct but slow on cold cache).
    const kwmRows = await fetchKwmHistory(dbUrl, searchTermId);
    // No variant data needed for charts (series doesn't store them).
    chartHistory = kwmRows.map((r) => mapHistory(r, new Map(), fits));
  }

  return {
    searchTermId: term.id,
    searchTermRaw: term.search_term_raw,
    searchTermNormalized: term.search_term_normalized,
    firstSeenWeek: toIsoDate(term.first_seen_week),
    lastSeenWeek: toIsoDate(term.last_seen_week),
    current,
    chartHistory,
    enrichedProductsByAsin,
    currentWeekProductSlots,
    currentWeekVariants,
  };
}

// ---------------------------------------------------------------------------
// fetchKeywordRawHistory — SLOW loader for the streamed Weekly History table
// ---------------------------------------------------------------------------

/**
 * Slow loader: full 52-week kwm scan with ALL columns (including product
 * ASINs/titles, categories, variants) for the RawDataTable.
 * Intended to be called from an async server component inside <Suspense>.
 */
export async function fetchKeywordRawHistory(
  searchTermId: string,
): Promise<KeywordDetailHistoryRow[]> {
  const dbUrl = env.DATABASE_URL;
  const sql = neon(dbUrl);

  const [kwmRows, variantRowsAny, fitsResult] = await Promise.all([
    fetchKwmHistory(dbUrl, searchTermId),
    sql`
      SELECT week_end_date, duplicate_count, losing_ranks, raw_examples
      FROM import_duplicate_search_terms
      WHERE search_term_id = ${searchTermId}
    `,
    fetchFits(dbUrl),
  ]);

  const variantRows = variantRowsAny as unknown as Array<{
    week_end_date: string;
    duplicate_count: number;
    losing_ranks: number[];
    raw_examples: string[];
  }>;
  const variantsByWeek = new Map<string, KeywordVariantInfo>();
  for (const v of variantRows) {
    variantsByWeek.set(toIsoDate(v.week_end_date), {
      duplicateCount: v.duplicate_count,
      losingRanks: v.losing_ranks ?? [],
      rawExamples: v.raw_examples ?? [],
    });
  }

  return kwmRows.map((r) => mapHistory(r, variantsByWeek, fitsResult));
}
