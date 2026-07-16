/**
 * Load explorer rows for an explicit set of keyword IDs. Used by the
 * /watchlist page. Returns the same ExplorerRow shape runExplorerQuery
 * produces, so ResultsTable can render the result identically.
 *
 * Why a duplicate of the SELECT/FROM/JOIN from buildExplorerQuery instead
 * of a shared helper: keeping the projection co-located with each entry
 * point's WHERE/ORDER logic is simpler to read and lets the watchlist
 * helper stay tiny. If a third caller appears we should extract a shared
 * projection, but two is the YAGNI line.
 *
 * Window + sort are honored. matchMode only affects the title-gap sort
 * (the matchMode-specific count column), mirroring buildExplorerQuery.
 *
 * Rows come back ordered by `sort`, NOT in the order keywordIds was
 * passed in. The caller (the /watchlist page) re-sorts in JS for sort
 * keys this layer doesn't understand (the watchlist-only 'added_*' keys).
 */
import 'server-only';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { volumeDeltaExpr, volumePriorExpr } from './buildQuery';
import type {
  ExplorerRow,
  MatchMode,
  SortKey,
  WindowKey,
} from './types';

const WINDOW_TO_RANK_COLUMN: Record<WindowKey, string> = {
  '1w': 'prior_week_rank',
  '4w': 'rank_4w_ago',
  '13w': 'rank_13w_ago',
  '26w': 'rank_26w_ago',
  '52w': 'rank_52w_ago',
};

const WINDOW_TO_IMPROVEMENT_COLUMN: Record<WindowKey, string> = {
  '1w': 'improvement_1w',
  '4w': 'improvement_4w',
  '13w': 'improvement_13w',
  '26w': 'improvement_26w',
  '52w': 'improvement_52w',
};

// Mirror runQuery.ts RawRow — keep in lock-step with the projection in
// buildExplorerQuery + its mapper.
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
  volume_prior: string | number | null;
  volume_delta: string | number | null;
  avg_price_cents: string | number | null;
  avg_reviews: number | null;
  top_clicked_leaf_category: string | null;
}

export async function fetchExplorerRowsByIds(opts: {
  keywordIds: string[];
  window: WindowKey;
  sort: SortKey;
  matchMode: MatchMode;
}): Promise<ExplorerRow[]> {
  if (opts.keywordIds.length === 0) return [];

  const sqlClient = neon(env.DATABASE_URL);

  const priorRankCol = WINDOW_TO_RANK_COLUMN[opts.window];
  const improvementCol = WINDOW_TO_IMPROVEMENT_COLUMN[opts.window];
  const orderBy = buildOrderBy(opts.sort, opts.window, opts.matchMode);

  // The SELECT list is byte-for-byte the same projection
  // buildExplorerQuery emits, so the row mapper output is identical to
  // runExplorerQuery's. Don't refactor without keeping these in lock-step.
  const selectList = `
      kcs.search_term_id,
      st.search_term_raw,
      kcs.current_rank,
      kcs.${priorRankCol} AS prior_rank,
      kcs.${improvementCol} AS improvement,
      ${volumePriorExpr(opts.window, 'kcs.')} AS volume_prior,
      ${volumeDeltaExpr(opts.window, 'kcs.')} AS volume_delta,
      kcs.top_clicked_category_1_current,
      kcs.fake_volume_severity_current,
      kcs.keyword_title_match_count_current,
      kcs.keyword_in_title_1_current,
      kcs.keyword_in_title_2_current,
      kcs.keyword_in_title_3_current,
      kcs.keyword_title_match_count_loose_current,
      kcs.keyword_in_title_1_loose_current,
      kcs.keyword_in_title_2_loose_current,
      kcs.keyword_in_title_3_loose_current,
      kcs.top_clicked_product_1_asin_current,
      kcs.top_clicked_product_1_title_current,
      kcs.top_clicked_product_1_click_share_current,
      kcs.top_clicked_product_1_conversion_share_current,
      kcs.estimated_monthly_volume_current,
      kcs.avg_price_cents,
      kcs.avg_reviews,
      kcs.top_clicked_leaf_category
  `.trim();

  const sqlText = `
    SELECT
      ${selectList}
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    WHERE kcs.search_term_id = ANY($1::uuid[])
    ${orderBy}
  `.trim();

  const rawRowsAny = await sqlClient.query(sqlText, [opts.keywordIds]);
  const rawRows = rawRowsAny as unknown as RawRow[];

  // Mirror runQuery.ts row mapper — keep in lock-step with the RawRow
  // interface above + the SELECT list emitted by buildExplorerQuery.
  return rawRows.map((r) => ({
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
    volumePrior: parseBigint(r.volume_prior),
    volumeDelta: parseBigint(r.volume_delta),
    avgPriceCents: parseBigint(r.avg_price_cents),
    avgReviews: r.avg_reviews ?? null,
    topClickedLeafCategory: r.top_clicked_leaf_category ?? null,
  }));
}

/**
 * Mirrors buildExplorerQuery.buildOrderBy. The 'added_asc' / 'added_desc'
 * keys are in the SortKey union but are watchlist-only — this layer
 * silently falls back to the default rank ordering for them, and the
 * watchlist page re-sorts in JS.
 */
function buildOrderBy(
  sort: SortKey,
  window: WindowKey,
  matchMode: MatchMode,
): string {
  switch (sort) {
    case 'rank':
      return 'ORDER BY kcs.current_rank ASC';
    case 'rank_desc':
      return 'ORDER BY kcs.current_rank DESC';
    // NULLS LAST, not the explorer's eligibility exclusion — watchlist rows are never hidden (spec amendment 2026-07-16).
    case 'imp':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} DESC NULLS LAST`;
    case 'decline':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} ASC NULLS LAST`;
    case 'title_gap': {
      const col = matchMode === 'loose'
        ? 'keyword_title_match_count_loose_current'
        : 'keyword_title_match_count_current';
      return `ORDER BY kcs.${col} ASC NULLS FIRST`;
    }
    case 'avg_price_asc':
      return 'ORDER BY kcs.avg_price_cents ASC NULLS LAST';
    case 'avg_price_desc':
      return 'ORDER BY kcs.avg_price_cents DESC NULLS LAST';
    case 'avg_reviews_asc':
      return 'ORDER BY kcs.avg_reviews ASC NULLS LAST';
    case 'avg_reviews_desc':
      return 'ORDER BY kcs.avg_reviews DESC NULLS LAST';
    default:
      // Defensive: 'added_asc' / 'added_desc' (watchlist-only) land here,
      // as does any future unknown key — fall back to rank.
      return 'ORDER BY kcs.current_rank ASC';
  }
}

/**
 * Postgres bigint columns come back as strings from pg/neon-http to
 * preserve full 64-bit precision. Top values are well under 2^53.
 * Identical to runQuery.ts's parseBigint.
 */
function parseBigint(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? parseInt(v, 10) : v;
}
