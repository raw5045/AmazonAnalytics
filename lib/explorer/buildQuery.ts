/**
 * buildExplorerQuery — pure function that turns ExplorerFilters into the
 * SQL strings + arg arrays needed to fetch a paged, sorted, filtered set
 * of keywords from `keyword_current_summary` (joined to `search_terms`).
 *
 * Reads only from kcs + search_terms — no kwm scans on the hot path.
 * The output of this function is what the page.tsx server component
 * runs against pg.Pool / Drizzle; tests assert on the SQL/args shape
 * across the matrix of filter combinations.
 *
 * Param-binding strategy: a single `args` array shared between the main
 * SELECT and the COUNT(*). The COUNT consumes the WHERE-clause args only;
 * the main SELECT additionally consumes LIMIT/OFFSET appended to the end.
 */
import type {
  BuiltExplorerQuery,
  ExplorerFilters,
  MatchMode,
  WindowKey,
} from './types';
import { findJumpPreset } from './jumpPresets';

const WINDOW_TO_RANK_COLUMN: Record<WindowKey, string> = {
  '1w': 'prior_week_rank',
  '4w': 'rank_4w_ago',
  '13w': 'rank_13w_ago',
  '26w': 'rank_26w_ago',
  '52w': 'rank_52w_ago',
};

const WINDOW_TO_VOLUME_COLUMN: Record<WindowKey, string> = {
  '1w': 'estimated_monthly_volume_1w_ago',
  '4w': 'estimated_monthly_volume_4w_ago',
  '13w': 'estimated_monthly_volume_13w_ago',
  '26w': 'estimated_monthly_volume_26w_ago',
  '52w': 'estimated_monthly_volume_52w_ago',
};

const WINDOW_TO_IMPROVEMENT_COLUMN: Record<WindowKey, string> = {
  '1w': 'improvement_1w',
  '4w': 'improvement_4w',
  '13w': 'improvement_13w',
  '26w': 'improvement_26w',
  '52w': 'improvement_52w',
};

export function buildExplorerQuery(
  filters: ExplorerFilters,
  /**
   * Optional. When provided, injects `kcs.current_week_end_date = ?`
   * as the FIRST WHERE clause so the existing composite indexes
   * (kcs_rank_idx, kcs_category_idx, etc., all leading with
   * current_week_end_date) become usable for sorted output. kcs only
   * holds one current_week_end_date value at a time, so this is a
   * no-op semantically — purely a planner hint.
   *
   * Source is the single-row keyword_current_summary_meta table,
   * updated atomically with the kcs stage-and-swap. When omitted
   * (e.g. meta row missing or fetch failed), the query falls back to
   * today's behavior: seq scan + sort. See the explorer-perf RFC.
   */
  currentWeekEndDate?: string,
): BuiltExplorerQuery {
  const args: unknown[] = [];
  const next = (val: unknown): string => {
    args.push(val);
    return `$${args.length}`;
  };

  const priorRankCol = WINDOW_TO_RANK_COLUMN[filters.window];
  const improvementCol = WINDOW_TO_IMPROVEMENT_COLUMN[filters.window];
  const orderBy = buildOrderBy(filters.sort, improvementCol, filters.matchMode);

  // kcs SELECT columns shared by both paths. The search_term_raw source
  // differs (st in the legacy join, m in the CTE), so it's templated.
  const kcsSelect = (rawSrc: string): string => `
      kcs.search_term_id,
      ${rawSrc}.search_term_raw,
      kcs.current_rank,
      kcs.${priorRankCol} AS prior_rank,
      kcs.${improvementCol} AS improvement,
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

  // ---- q (substring) path: trigram-first MATERIALIZED CTE ----
  if (filters.q && filters.q.length >= 3) {
    const qParam = next(`%${filters.q.toLowerCase()}%`);
    const capParam = next(Q_MATCH_MATERIALIZE_CAP);
    const where = pushKcsPredicates(filters, currentWeekEndDate, next);
    const whereClause = where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : '';
    const countArgs = [...args];
    const limitParam = next(filters.perPage);
    const offsetParam = next((filters.page - 1) * filters.perPage);

    const sql = `
    WITH matches AS MATERIALIZED (
      SELECT id, search_term_raw
      FROM search_terms
      WHERE search_term_normalized LIKE ${qParam}
      LIMIT ${capParam}
    )
    SELECT
      ${kcsSelect('m')},
      (count(*) OVER ())::int AS total
    FROM keyword_current_summary kcs
    JOIN matches m ON m.id = kcs.search_term_id
    ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();

    // Empty-page fallback only (OFFSET past the end → no row to carry the
    // window total). The runner calls this just when the rows result is
    // empty; normal pages get the total for free from the rows pass.
    const countSql = `
    SELECT count(*)::int AS total
    FROM (
      WITH matches AS MATERIALIZED (
        SELECT id
        FROM search_terms
        WHERE search_term_normalized LIKE ${qParam}
        LIMIT ${capParam}
      )
      SELECT 1
      FROM keyword_current_summary kcs
      JOIN matches m ON m.id = kcs.search_term_id
      ${whereClause}
    ) sub
  `.trim();

    return { sql, args, countSql, countArgs, countFromRows: true };
  }

  // ---- legacy path (q is null): identical output to before ----
  const where = pushKcsPredicates(filters, currentWeekEndDate, next);
  const whereClause = where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : '';

  // Snapshot args length BEFORE appending limit/offset so countArgs is the
  // exact prefix consumed by countSql.
  const countArgs = [...args];
  const limitParam = next(filters.perPage);
  const offsetParam = next((filters.page - 1) * filters.perPage);

  const sql = `
    SELECT
      ${kcsSelect('st')}
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();

  // Bail-out count: an exact COUNT(*) over millions of rows is a 1-3s
  // sequential aggregate. We only need to render a pagination footer, so
  // count up to COUNT_CAP+1 rows. If we hit the cap, the UI shows "10,000+"
  // and pagination caps at the same number — the user almost certainly
  // wants to refine filters before page 100 anyway.
  //
  // This (legacy, q=null) path's predicates are all on kcs, so the count
  // needs no search_terms join. The conditional below is a safety net:
  // should a future kcs-path filter ever emit an `st.` clause, the join is
  // added automatically (safe — kcs.search_term_id is a NOT NULL FK to
  // search_terms.id, so the inner join can't change the row count). The
  // `q` substring filter — the one st-referencing clause today — takes the
  // CTE path above, never this one.
  const countJoin = whereClause.includes('st.')
    ? '\n      JOIN search_terms st ON st.id = kcs.search_term_id'
    : '';
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT 1
      FROM keyword_current_summary kcs${countJoin}
      ${whereClause}
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `.trim();

  return { sql, args, countSql, countArgs };
}

/**
 * Maximum rows we count exactly. Beyond this, the UI shows "{cap}+" and
 * pagination caps at this count. Set high enough that real usage rarely
 * hits it, low enough that the count completes quickly even on cold cache.
 */
export const COUNT_CAP = 10_000;

/**
 * Max number of trigram matches the `q` path materializes + sorts (a
 * work cap, distinct from COUNT_CAP's display cap). Below this, results
 * are exact and fully rank-correct (covers all realistic searches — e.g.
 * "hair" ≈ 35k matches). Above it (pathologically broad 3-char
 * substrings), we read only the first 50k trigram matches — a documented
 * degradation that bounds worst-case latency. Either way the runner still
 * caps the *displayed* total at COUNT_CAP (10k → "10,000+"), so this cap
 * rarely changes what the user sees. See the explorer-filter-perf spec §3.3.
 */
export const Q_MATCH_MATERIALIZE_CAP = 50_000;

/**
 * Push every kcs WHERE predicate (current_week_end_date, rank, jump,
 * category, leaf, severity, title-gap) onto a fresh clause list, binding
 * args via `next` in clause order. The `q` substring filter is NOT here —
 * it is path-specific (CTE for the q path; absent on the legacy path).
 */
function pushKcsPredicates(
  filters: ExplorerFilters,
  currentWeekEndDate: string | undefined,
  next: (val: unknown) => string,
): string[] {
  const where: string[] = [];
  const priorRankCol = WINDOW_TO_RANK_COLUMN[filters.window];

  if (currentWeekEndDate) {
    where.push(`kcs.current_week_end_date = ${next(currentWeekEndDate)}::date`);
  }
  if (filters.rankMin !== null) {
    where.push(`kcs.current_rank >= ${next(filters.rankMin)}`);
  }
  if (filters.rankMax !== null) {
    where.push(`kcs.current_rank <= ${next(filters.rankMax)}`);
  }
  if (filters.jump) {
    let from: number | null = null;
    let to: number | null = null;
    if (filters.jump === 'custom') {
      from = filters.jumpFrom;
      to = filters.jumpTo;
    } else {
      const found = findJumpPreset(filters.jump);
      if (found) { from = found.preset.from; to = found.preset.to; }
    }
    if (from !== null && to !== null) {
      if (filters.jumpMetric === 'volume') {
        const volCol = WINDOW_TO_VOLUME_COLUMN[filters.window];
        where.push(`kcs.${volCol} < ${next(from)} AND kcs.estimated_monthly_volume_current > ${next(to)}`);
      } else {
        where.push(`kcs.${priorRankCol} > ${next(from)} AND kcs.current_rank < ${next(to)}`);
      }
    }
  }
  if (filters.category) {
    where.push(`kcs.top_clicked_category_1_current = ${next(filters.category)}`);
  }
  if (filters.leafCategories.length > 0) {
    const ps = filters.leafCategories.map((c) => next(c)).join(', ');
    where.push(`kcs.top_clicked_leaf_category IN (${ps})`);
  }
  if (filters.severities.length > 0 && filters.severities.length < 3) {
    const params = filters.severities.map((s) => next(s)).join(', ');
    if (filters.severities.includes('none')) {
      where.push(`(kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN (${params}))`);
    } else {
      where.push(`kcs.fake_volume_severity_current IN (${params})`);
    }
  }
  if (filters.titleMatchMode && filters.titleSlots.length > 0) {
    const conditions = filters.titleSlots.map((slot) => `NOT ${slotColumn(slot, filters.matchMode)}`);
    const joiner = filters.titleMatchMode === 'all' ? ' AND ' : ' OR ';
    where.push(`(${conditions.join(joiner)})`);
  }
  return where;
}

function buildOrderBy(
  sort: ExplorerFilters['sort'],
  improvementCol: string,
  matchMode: MatchMode,
): string {
  switch (sort) {
    case 'rank':
      return 'ORDER BY kcs.current_rank ASC';
    case 'rank_desc':
      return 'ORDER BY kcs.current_rank DESC';
    case 'imp':
      return `ORDER BY kcs.${improvementCol} DESC NULLS LAST`;
    case 'decline':
      return `ORDER BY kcs.${improvementCol} ASC NULLS LAST`;
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
    case 'added_asc':
    case 'added_desc':
      // Watchlist-only sort keys — meaningless on the explorer page
      // (no per-user "added" timestamp on the explorer's row set).
      // Fall back to default rank ordering.
      return 'ORDER BY kcs.current_rank ASC';
  }
}

/** Returns the per-slot in-title boolean column for a given match mode. */
function slotColumn(slot: number, matchMode: MatchMode): string {
  return matchMode === 'loose'
    ? `kcs.keyword_in_title_${slot}_loose_current`
    : `kcs.keyword_in_title_${slot}_current`;
}
