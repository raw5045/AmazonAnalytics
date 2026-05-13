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
  JumpKey,
  MatchMode,
  WindowKey,
} from './types';

/**
 * Map preset JumpKeys to (rank_Nw_ago > X, current_rank < Y) thresholds.
 * The 'custom' variant reads from filters.jumpFrom / filters.jumpTo
 * instead — see the dispatch in buildExplorerQuery.
 *
 * The SQL applied is `rank_${window}w_ago > X AND current_rank < Y`.
 */
type PresetJumpKey = Exclude<JumpKey, 'custom'>;
const JUMP_THRESHOLDS: Record<PresetJumpKey, { from: number; to: number }> = {
  '500k_to_100k': { from: 500_000, to: 100_000 },
  '100k_to_50k': { from: 100_000, to: 50_000 },
  '100k_to_10k': { from: 100_000, to: 10_000 },
  '50k_to_10k': { from: 50_000, to: 10_000 },
};

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
  const where: string[] = [];

  const next = (val: unknown): string => {
    args.push(val);
    return `$${args.length}`;
  };

  const priorRankCol = WINDOW_TO_RANK_COLUMN[filters.window];
  const improvementCol = WINDOW_TO_IMPROVEMENT_COLUMN[filters.window];

  // 1.1 — current_week_end_date predicate (the planner hint). Goes
  // first in the WHERE so it's the leading column-equality the
  // composite indexes need.
  if (currentWeekEndDate) {
    const p = next(currentWeekEndDate);
    where.push(`kcs.current_week_end_date = ${p}::date`);
  }

  // 1.2 — search term substring (q): ILIKE on the trigram-indexed normalized column
  if (filters.q && filters.q.length >= 3) {
    const param = next(`%${filters.q.toLowerCase()}%`);
    where.push(`st.search_term_normalized LIKE ${param}`);
  }

  // 1.3 — current rank min/max
  if (filters.rankMin !== null) {
    const p = next(filters.rankMin);
    where.push(`kcs.current_rank >= ${p}`);
  }
  if (filters.rankMax !== null) {
    const p = next(filters.rankMax);
    where.push(`kcs.current_rank <= ${p}`);
  }

  // 1.4 — threshold jump (uses the window-specific rank_Nw_ago column)
  if (filters.jump) {
    let from: number;
    let to: number;
    if (filters.jump === 'custom') {
      // parseFilters has already validated that both values are present
      // and from > to when jump === 'custom'; non-null asserts are safe.
      from = filters.jumpFrom!;
      to = filters.jumpTo!;
    } else {
      ({ from, to } = JUMP_THRESHOLDS[filters.jump]);
    }
    const fromParam = next(from);
    const toParam = next(to);
    // For the 1w window we use prior_week_rank; for other windows we use rank_Nw_ago.
    where.push(`kcs.${priorRankCol} > ${fromParam} AND kcs.current_rank < ${toParam}`);
  }

  // 1.5 — top clicked category #1
  if (filters.category) {
    const p = next(filters.category);
    where.push(`kcs.top_clicked_category_1_current = ${p}`);
  }

  // 1.6 — fake volume severity (default = none, warning)
  // NULL severity means "couldn't evaluate"; treat NULL as belonging to 'none'
  // since the visual default hides nothing more than the chosen levels.
  if (filters.severities.length > 0 && filters.severities.length < 3) {
    const params = filters.severities.map((s) => next(s)).join(', ');
    if (filters.severities.includes('none')) {
      where.push(`(kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN (${params}))`);
    } else {
      where.push(`kcs.fake_volume_severity_current IN (${params})`);
    }
  }

  // 1.7 — title-gap filter (operates on the matchMode-selected slot columns)
  if (filters.titleMatchMode && filters.titleSlots.length > 0) {
    const slotCols = filters.titleSlots.map((slot) => slotColumn(slot, filters.matchMode));
    if (filters.titleMatchMode === 'all') {
      // "Missing from all selected" — every selected slot is false
      const conditions = slotCols.map((c) => `NOT ${c}`);
      where.push(`(${conditions.join(' AND ')})`);
    } else {
      // "Missing from any selected" — at least one selected slot is false
      const conditions = slotCols.map((c) => `NOT ${c}`);
      where.push(`(${conditions.join(' OR ')})`);
    }
  }

  // ORDER BY (title_gap sort uses the matchMode-specific count column)
  const orderBy = buildOrderBy(filters.sort, improvementCol, filters.matchMode);

  // SELECT list — priorRankCol and improvementCol are dynamically chosen
  // based on the window, but exposed under the stable aliases
  // prior_rank / improvement so the row mapper does not need to know
  // which window was selected. We always SELECT both the strict and
  // loose match flag/count columns; the UI picks which to display.
  const selectList = `
      kcs.search_term_id,
      st.search_term_raw,
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
      kcs.top_clicked_product_1_conversion_share_current
  `.trim();

  const whereClause = where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : '';

  // Snapshot args length BEFORE appending limit/offset so countArgs is the
  // exact prefix consumed by countSql.
  const countArgs = [...args];
  const limitParam = next(filters.perPage);
  const offsetParam = next((filters.page - 1) * filters.perPage);

  const sql = `
    SELECT
      ${selectList}
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
  // JOIN optimization: only join search_terms when filters.q is set
  // (only filter that references the joined table). For all other
  // filters the WHERE clause is entirely against kcs, so the JOIN is
  // pure overhead — 10001 PK lookups against search_terms, each a
  // random read on cold Neon storage. Skipping shaves seconds off the
  // cold count for non-q filter combinations.
  const countNeedsSearchTermsJoin = filters.q !== null && filters.q.length >= 3;
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT 1
      FROM keyword_current_summary kcs
      ${countNeedsSearchTermsJoin ? 'JOIN search_terms st ON st.id = kcs.search_term_id' : ''}
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
  }
}

/** Returns the per-slot in-title boolean column for a given match mode. */
function slotColumn(slot: number, matchMode: MatchMode): string {
  return matchMode === 'loose'
    ? `kcs.keyword_in_title_${slot}_loose_current`
    : `kcs.keyword_in_title_${slot}_current`;
}
