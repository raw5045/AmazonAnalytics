/**
 * Server-side data fetcher for the /explorer/keyword/<id> page.
 *
 * Two queries run in parallel:
 *   1. The kcs row + search_terms row (1-row "current snapshot")
 *   2. The full kwm history for this term (up to 52 rows)
 *
 * Both hit existing indexes (kcs PK on search_term_id, kwm_term_week_idx)
 * and complete in <100 ms on warm cache.
 */
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import type { SeverityKey } from './types';

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
  fakeVolumeSeverity: SeverityKey | null;
  fakeVolumeEvalStatus: string | null;
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
}

/**
 * Returns null when the search_term doesn't exist (404 case for the page).
 */
export async function fetchKeywordDetail(
  searchTermId: string,
): Promise<KeywordDetail | null> {
  const sql = neon(env.DATABASE_URL);

  const [termRowsAny, currentRowsAny, historyRowsAny] = await Promise.all([
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
        fake_volume_severity_current,
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
        fake_volume_severity,
        fake_volume_eval_status
      FROM keyword_weekly_metrics
      WHERE search_term_id = ${searchTermId}
      ORDER BY week_end_date ASC
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

  if (termRows.length === 0) return null;
  const term = termRows[0];

  const current: KeywordDetailCurrent | null = currentRows.length > 0
    ? mapCurrent(currentRows[0])
    : null;

  return {
    searchTermId: term.id,
    searchTermRaw: term.search_term_raw,
    searchTermNormalized: term.search_term_normalized,
    firstSeenWeek: toIsoDate(term.first_seen_week),
    lastSeenWeek: toIsoDate(term.last_seen_week),
    current,
    history: historyRows.map(mapHistory),
  };
}

function mapCurrent(r: Record<string, unknown>): KeywordDetailCurrent {
  return {
    currentWeekEndDate: toIsoDate(r.current_week_end_date as string),
    currentRank: r.current_rank as number,
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
  };
}

function mapHistory(r: Record<string, unknown>): KeywordDetailHistoryRow {
  return {
    weekEndDate: toIsoDate(r.week_end_date as string),
    actualRank: r.actual_rank as number,
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
    fakeVolumeSeverity: (r.fake_volume_severity as SeverityKey | null) ?? null,
    fakeVolumeEvalStatus: (r.fake_volume_eval_status as string | null) ?? null,
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
