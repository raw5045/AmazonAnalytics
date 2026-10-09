// lib/products/loadProductKeywords.ts
/**
 * The ASIN page's keywords block (spec 2026-10-09 §6.3): the keywords the ASIN is a top-3 clicked
 * product for this week, from the keyword_top_asins reverse table joined to the current summary,
 * best keyword rank first, capped at 500 with the full count alongside ("showing 500 of N").
 * The count joins the summary exactly as the list does, so N is what the list could show.
 */
import type { SqlRunner, SqlStatement } from './searchProducts';

export const PRODUCT_KEYWORDS_CAP = 500;

export interface ProductKeywordRow {
  searchTermId: string;
  searchTermRaw: string;
  /** The keyword's current search-frequency rank. */
  currentRank: number;
  /** estimated_monthly_volume_current; null when no calibration fit exists. */
  estimatedMonthlySearches: number | null;
  /** The ASIN's click-share position for this keyword (1 = most clicked). */
  slot: 1 | 2 | 3;
  /** Percent (0–100) of the keyword's clicks and conversions that went to this product; null when Amazon gave none. */
  clickSharePct: number | null;
  conversionSharePct: number | null;
  /** Consecutive imported weeks, ending now, the ASIN has been in this keyword's top 3 (any slot). */
  weeksInTop3: number;
  /** The first week of that run (YYYY-MM-DD). */
  streakStartedWeek: string;
}

export interface ProductKeywordsResult {
  rows: ProductKeywordRow[];
  /** Every keyword the ASIN is in the top 3 for, whatever the cap. */
  total: number;
}

/**
 * The bigint, numeric and date columns are cast to text, so the page gets plain strings whatever
 * the driver's type parsers do. Best rank first (current_rank is NOT NULL), the keyword id breaking
 * ties so the rows kept under the cap are the same on every read.
 */
export function productKeywordsSql(asin: string, limit: number): SqlStatement {
  return {
    text: `SELECT st.search_term_raw, kcs.search_term_id, kcs.current_rank,
  kcs.estimated_monthly_volume_current::text AS estimated_monthly_volume_current,
  k.slot, k.click_share::text AS click_share, k.conversion_share::text AS conversion_share,
  k.weeks_in_top3, k.streak_started_week::text AS streak_started_week
FROM keyword_top_asins k
JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id
JOIN search_terms st ON st.id = kcs.search_term_id
WHERE k.asin = $1
ORDER BY kcs.current_rank ASC, k.search_term_id
LIMIT $2`,
    values: [asin, limit],
  };
}

/** The list's rows without the cap. Every summary row has its search_terms row (foreign key), so that join is left out. */
export function productKeywordCountSql(asin: string): SqlStatement {
  return {
    text: `SELECT count(*)::int AS n
FROM keyword_top_asins k
JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id
WHERE k.asin = $1`,
    values: [asin],
  };
}

interface KeywordRow {
  search_term_raw: string;
  search_term_id: string;
  current_rank: number;
  estimated_monthly_volume_current: string | number | null;
  slot: number;
  click_share: string | number | null;
  conversion_share: string | number | null;
  weeks_in_top3: number;
  streak_started_week: string;
}

/** A text (or number) column as a number; null when missing or not a finite number (numeric can hold NaN). */
function numberOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRow(r: KeywordRow): ProductKeywordRow {
  return {
    searchTermId: r.search_term_id,
    searchTermRaw: r.search_term_raw,
    currentRank: r.current_rank,
    estimatedMonthlySearches: numberOrNull(r.estimated_monthly_volume_current),
    slot: r.slot as 1 | 2 | 3, // keyword_top_asins CHECKs slot IN (1, 2, 3)
    clickSharePct: numberOrNull(r.click_share),
    conversionSharePct: numberOrNull(r.conversion_share),
    weeksInTop3: r.weeks_in_top3,
    streakStartedWeek: r.streak_started_week,
  };
}

/**
 * The ASIN's current top-3 keywords, best rank first. `limit` is the page's 500; the research tool
 * passes 100. The list and the count run in parallel (two statements, one round trip of latency).
 */
export async function loadProductKeywords(run: SqlRunner, asin: string, limit: number = PRODUCT_KEYWORDS_CAP): Promise<ProductKeywordsResult> {
  const rowsQuery = productKeywordsSql(asin, limit);
  const countQuery = productKeywordCountSql(asin);
  const [rows, count] = await Promise.all([
    run(rowsQuery.text, rowsQuery.values) as Promise<KeywordRow[]>,
    run(countQuery.text, countQuery.values) as Promise<Array<{ n: number }>>,
  ]);
  return { rows: rows.map(toRow), total: count[0]?.n ?? 0 };
}
