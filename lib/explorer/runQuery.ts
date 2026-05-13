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
 * The page.tsx server component imports this; raw SQL stays in buildQuery.ts
 * so it remains pure and easy to unit-test.
 */
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { buildExplorerQuery, COUNT_CAP } from './buildQuery';
import type { ExplorerFilters, ExplorerRow } from './types';

interface ExplorerQueryResult {
  rows: ExplorerRow[];
  total: number;
  /** True when total === COUNT_CAP and the real total may be larger. */
  totalIsCapped: boolean;
  /** Per-layer wall-clock timings for the perf instrumentation strip. */
  timings: {
    /** Meta-row lookup that supplies the current_week_end_date predicate. */
    metaLookupMs: number;
    /** Main paged SELECT (LIMIT 100 OFFSET …). */
    rowsMs: number;
    /** Bail-out COUNT(*) with LIMIT 10001. */
    countMs: number;
    /** True if buildExplorerQuery was given a currentWeekEndDate (fast path). */
    usedPredicate: boolean;
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
}

export async function runExplorerQuery(
  filters: ExplorerFilters,
): Promise<ExplorerQueryResult> {
  const sqlClient = neon(env.DATABASE_URL);

  // Fast path: fetch the current_week_end_date from the one-row meta
  // table so we can inject it as a leading-column equality predicate.
  // This lets the existing composite indexes (kcs_rank_idx etc.) serve
  // sorted output instead of falling back to seq scan + sort-to-disk.
  // See db/migrations/0020_kcs_meta.sql + the explorer-perf RFC.
  //
  // Graceful fallback: if the meta row is missing or the fetch throws
  // for any reason, leave currentWeekEndDate undefined and let
  // buildExplorerQuery emit the predicate-free shape (today's slow
  // behavior, but never broken). This is also the kill switch — to
  // disable the new fast path without redeploying, TRUNCATE the meta
  // table.
  let currentWeekEndDate: string | undefined;
  const tMetaStart = Date.now();
  try {
    const metaRows = (await sqlClient`
      SELECT current_week_end_date::text AS d
      FROM keyword_current_summary_meta
      WHERE singleton = true
    `) as Array<{ d: string }>;
    currentWeekEndDate = metaRows[0]?.d;
  } catch {
    currentWeekEndDate = undefined;
  }
  const metaLookupMs = Date.now() - tMetaStart;

  const { sql, args, countSql, countArgs } = buildExplorerQuery(filters, currentWeekEndDate);

  // Run rows + count in parallel but capture each timing individually
  // so we can see which one (if either) dominates.
  const tRowsStart = Date.now();
  const rowsPromise = sqlClient.query(sql, args).then((r) => {
    return { result: r, ms: Date.now() - tRowsStart };
  });
  const tCountStart = Date.now();
  const countPromise = sqlClient.query(countSql, countArgs).then((r) => {
    return { result: r, ms: Date.now() - tCountStart };
  });
  const [rowsTimed, countTimed] = await Promise.all([rowsPromise, countPromise]);
  const rawRowsAny = rowsTimed.result;
  const countRowsAny = countTimed.result;
  const rawRows = rawRowsAny as unknown as RawRow[];
  const countRows = countRowsAny as unknown as Array<{ total: number | string }>;

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
  }));

  // The COUNT(*) is capped at COUNT_CAP+1 by the bail-out subquery —
  // if it returned exactly COUNT_CAP+1 we know the real total is at
  // least that, but not how much larger.
  const rawTotal = countRows.length > 0
    ? typeof countRows[0].total === 'string'
      ? parseInt(countRows[0].total, 10)
      : countRows[0].total
    : 0;
  const totalIsCapped = rawTotal > COUNT_CAP;
  const total = totalIsCapped ? COUNT_CAP : rawTotal;

  return {
    rows,
    total,
    totalIsCapped,
    timings: {
      metaLookupMs,
      rowsMs: rowsTimed.ms,
      countMs: countTimed.ms,
      usedPredicate: currentWeekEndDate !== undefined,
    },
  };
}
