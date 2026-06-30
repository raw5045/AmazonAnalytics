/**
 * buildExplorerQuery — pure function that turns ExplorerFilters into the
 * SQL strings + arg arrays needed to fetch a paged, sorted, filtered set
 * of keywords from `keyword_current_summary` (kcs).
 *
 * Two shapes:
 *  - no `q`: kcs joined to search_terms for the raw display text, ordered
 *    by the chosen sort, with a bail-out COUNT(*) for the footer.
 *  - `q` set: a single-table whole-word (`~ '\m…\M'`) or broad (`LIKE`)
 *    match on the denormalized `kcs.search_term_normalized` column. The
 *    inner subquery matches + sorts + limits + window-counts entirely on
 *    kcs (current-week-only, so no cap); the outer joins search_terms for
 *    raw text on just the page rows. The pagination total comes from
 *    `count(*) OVER ()` in the same pass (no separate count query).
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
import { wordPattern, broadPattern } from './matchPattern';

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

/**
 * The kcs display columns common to every path, in row-mapper order, AFTER
 * search_term_id / search_term_raw / current_rank / prior_rank / improvement.
 * Shared so the legacy join-select and the q-path inner/outer selects can't
 * drift. The runQuery row mapper reads each of these by name.
 */
const KCS_DISPLAY_COLS = [
  'top_clicked_category_1_current',
  'fake_volume_severity_current',
  'keyword_title_match_count_current',
  'keyword_in_title_1_current',
  'keyword_in_title_2_current',
  'keyword_in_title_3_current',
  'keyword_title_match_count_loose_current',
  'keyword_in_title_1_loose_current',
  'keyword_in_title_2_loose_current',
  'keyword_in_title_3_loose_current',
  'top_clicked_product_1_asin_current',
  'top_clicked_product_1_title_current',
  'top_clicked_product_1_click_share_current',
  'top_clicked_product_1_conversion_share_current',
  'estimated_monthly_volume_current',
  'avg_price_cents',
  'avg_reviews',
  'top_clicked_leaf_category',
] as const;

export function buildExplorerQuery(
  filters: ExplorerFilters,
  /**
   * Optional. When provided, injects `kcs.current_week_end_date = ?` as a
   * leading WHERE clause (a planner hint — kcs only holds one snapshot
   * week). Sourced from keyword_current_summary_meta.
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

  // ---- q path: single-table whole-word / broad match on the denormalized
  //      kcs.search_term_normalized (current-week-only, no cap). The inner
  //      subquery matches + sorts + limits + window-counts entirely on kcs;
  //      the outer join pulls search_term_raw from search_terms for ONLY the
  //      page rows (so raw is read for ~100 rows, not the whole match set).
  if (filters.q && filters.q.length >= 3) {
    const where = pushKcsPredicates(filters, currentWeekEndDate, next);
    const op = filters.qMode === 'broad' ? 'LIKE' : '~';
    const pattern = filters.qMode === 'broad' ? broadPattern(filters.q) : wordPattern(filters.q);
    where.push(`kcs.search_term_normalized ${op} ${next(pattern)}`);
    const whereClause = `WHERE ${where.join('\n        AND ')}`;
    const countArgs = [...args];
    const limitParam = next(filters.perPage);
    const offsetParam = next((filters.page - 1) * filters.perPage);

    const innerCols = [
      'kcs.search_term_id',
      'kcs.current_rank',
      `kcs.${priorRankCol} AS prior_rank`,
      `kcs.${improvementCol} AS improvement`,
      ...KCS_DISPLAY_COLS.map((c) => `kcs.${c}`),
    ].join(',\n        ');
    const outerCols = [
      'k.search_term_id',
      'st.search_term_raw',
      'k.current_rank',
      'k.prior_rank',
      'k.improvement',
      ...KCS_DISPLAY_COLS.map((c) => `k.${c}`),
      'k.total',
    ].join(',\n      ');

    const sql = `
    SELECT
      ${outerCols}
    FROM (
      SELECT
        ${innerCols},
        (count(*) OVER ())::int AS total
      FROM keyword_current_summary kcs
      ${whereClause}
      ${orderBy}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    ) k
    JOIN search_terms st ON st.id = k.search_term_id
    ${buildOuterOrderBy(filters.sort, filters.matchMode)}
  `.trim();

    // Empty-page fallback only (OFFSET past the end → no row carries the
    // window total). Single-table count over the same matched set.
    const countSql = `
    SELECT count(*)::int AS total
    FROM keyword_current_summary kcs
    ${whereClause}
  `.trim();

    return { sql, args, countSql, countArgs, countFromRows: true };
  }

  // ---- legacy path (q is null): kcs joined to search_terms for raw text ----
  const kcsSelect = `
      kcs.search_term_id,
      st.search_term_raw,
      kcs.current_rank,
      kcs.${priorRankCol} AS prior_rank,
      kcs.${improvementCol} AS improvement,
      ${KCS_DISPLAY_COLS.map((c) => `kcs.${c}`).join(',\n      ')}
  `.trim();

  const where = pushKcsPredicates(filters, currentWeekEndDate, next);
  const whereClause = where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : '';

  // Snapshot args length BEFORE appending limit/offset so countArgs is the
  // exact prefix consumed by countSql.
  const countArgs = [...args];
  // N+1: fetch one extra row so the runner can derive hasNext without a COUNT.
  // The runner slices back to perPage before returning. OFFSET stays perPage-based.
  const limitParam = next(filters.perPage + 1);
  const offsetParam = next((filters.page - 1) * filters.perPage);

  const sql = `
    SELECT
      ${kcsSelect}
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();

  // Bail-out count: an exact COUNT(*) over millions of rows is a 1-3s
  // sequential aggregate. We only need to render a pagination footer, so
  // count up to COUNT_CAP+1 rows. If we hit the cap the UI shows "10,000+"
  // and pagination caps there. This (legacy, q=null) path's predicates are
  // all on kcs, so the count needs no search_terms join.
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT 1
      FROM keyword_current_summary kcs
      ${whereClause}
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `.trim();

  return { sql, args, countSql, countArgs };
}

/**
 * Maximum rows we count exactly. Beyond this, the UI shows "{cap}+" and
 * pagination caps at this count.
 */
export const COUNT_CAP = 10_000;

/**
 * Push every kcs WHERE predicate (current_week_end_date, rank, jump,
 * category, leaf, severity, title-gap) onto a fresh clause list, binding
 * args via `next` in clause order. The `q` filter is NOT here — the q-path
 * appends its own match on kcs.search_term_normalized; the legacy path has
 * no q clause.
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
  if (filters.leafPaths.length > 0) {
    const ps = filters.leafPaths.map((c) => next(c)).join(', ');
    where.push(`kcs.top_clicked_category_path IN (${ps})`);
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

/** ORDER BY for the inner (kcs) query, by the window-specific source columns. */
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

/**
 * ORDER BY for the OUTER select of the q-path subquery — references the `k`
 * alias and the inner's stable aliases (`prior_rank` / `improvement`, not
 * the window-specific source columns). Mirrors buildOrderBy so the joined
 * page rows come out in the same order the inner LIMIT picked.
 */
function buildOuterOrderBy(sort: ExplorerFilters['sort'], matchMode: MatchMode): string {
  switch (sort) {
    case 'rank':
      return 'ORDER BY k.current_rank ASC';
    case 'rank_desc':
      return 'ORDER BY k.current_rank DESC';
    case 'imp':
      return 'ORDER BY k.improvement DESC NULLS LAST';
    case 'decline':
      return 'ORDER BY k.improvement ASC NULLS LAST';
    case 'title_gap': {
      const col = matchMode === 'loose'
        ? 'keyword_title_match_count_loose_current'
        : 'keyword_title_match_count_current';
      return `ORDER BY k.${col} ASC NULLS FIRST`;
    }
    case 'avg_price_asc':
      return 'ORDER BY k.avg_price_cents ASC NULLS LAST';
    case 'avg_price_desc':
      return 'ORDER BY k.avg_price_cents DESC NULLS LAST';
    case 'avg_reviews_asc':
      return 'ORDER BY k.avg_reviews ASC NULLS LAST';
    case 'avg_reviews_desc':
      return 'ORDER BY k.avg_reviews DESC NULLS LAST';
    case 'added_asc':
    case 'added_desc':
      return 'ORDER BY k.current_rank ASC';
  }
}

/** Returns the per-slot in-title boolean column for a given match mode. */
function slotColumn(slot: number, matchMode: MatchMode): string {
  return matchMode === 'loose'
    ? `kcs.keyword_in_title_${slot}_loose_current`
    : `kcs.keyword_in_title_${slot}_current`;
}
