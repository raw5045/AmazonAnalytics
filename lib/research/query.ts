import {
  COUNT_CAP,
  leafPathPredicate,
  severityPredicate,
  slotColumn,
  volumeDeltaEligibility,
  volumeDeltaExpr,
  volumePriorExpr,
  WINDOW_TO_RANK_COLUMN,
  WINDOW_TO_VOLUME_COLUMN,
  type NextParam,
} from '@/lib/explorer/buildQuery';
import { broadPattern, wordPattern } from '@/lib/explorer/matchPattern';
import type { BaselineStatus, Filters, IntegerRange, SearchRow, Severity, Sort, Window } from './contracts';

export interface CompileInput {
  filters: Filters;
  sort: Sort;
  window: Window;
  /** Resolved leaf paths (OR-set); empty = no category scope. */
  leaves: string[];
  currentWeekEndDate: string;
  offset: number;
  /** Rows to fetch (the service asks for pageSize + 1 to detect a next page). */
  limit: number;
}
export interface CompiledSearch { sql: string; args: unknown[]; countSql: string; countArgs: unknown[]; orderBy: string }

/** Exact comparator fragments for one column, in gt, gte, lt, lte order. */
export function rangePredicates(column: string, range: IntegerRange | null | undefined, next: NextParam): string[] {
  if (!range) return [];
  const out: string[] = [];
  if (range.gt !== undefined) out.push(`${column} > ${next(range.gt)}`);
  if (range.gte !== undefined) out.push(`${column} >= ${next(range.gte)}`);
  if (range.lt !== undefined) out.push(`${column} < ${next(range.lt)}`);
  if (range.lte !== undefined) out.push(`${column} <= ${next(range.lte)}`);
  return out;
}

const TAIL = 'kcs.current_rank ASC, kcs.search_term_id ASC';

/**
 * Deterministic total order. estimatedMonthlySearches runs as current_rank
 * because the stored estimate is monotone non-increasing in rank by
 * construction (guarded weekly by lib/analytics/volumeMonotonicity.ts).
 */
export function orderByFor(sort: Sort, window: Window): string {
  const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
  switch (sort.field) {
    case 'estimatedMonthlySearches':
      return `ORDER BY kcs.current_rank ${sort.direction === 'desc' ? 'ASC' : 'DESC'}, kcs.search_term_id ASC`;
    case 'rank':
      return `ORDER BY kcs.current_rank ${dir}, kcs.search_term_id ASC`;
    case 'averageReviews':
      return `ORDER BY kcs.avg_reviews ${dir} NULLS LAST, ${TAIL}`;
    case 'wordCount':
      return `ORDER BY kcs.word_count ${dir} NULLS LAST, ${TAIL}`;
    case 'volumeDelta':
      return `ORDER BY ${volumeDeltaExpr(window, 'kcs.')} ${dir} NULLS LAST, ${TAIL}`;
  }
}

/** Parent §8.2 movement semantics on top of the Explorer's window expressions. */
function movementPredicates(m: NonNullable<Filters['movement']>, next: NextParam): string[] {
  const w = m.window;
  const priorRankCol = `kcs.${WINDOW_TO_RANK_COLUMN[w]}`;
  const out: string[] = [];
  if (m.metric === 'volume') {
    // Same eligibility as the Explorer's Δ-volume sorts and the 0044 partial indexes:
    // current present; a present prior rank must carry a prior volume.
    out.push(`(${volumeDeltaEligibility(w, 'kcs.')})`);
    if (m.baseline === 'observed_only') out.push(`${priorRankCol} IS NOT NULL`);
    out.push(...rangePredicates(volumePriorExpr(w, 'kcs.'), m.prior, next));
    out.push(...rangePredicates('kcs.estimated_monthly_volume_current', m.current, next));
    out.push(...rangePredicates(volumeDeltaExpr(w, 'kcs.'), m.delta, next));
  } else if (m.baseline === 'observed_only') {
    out.push(`${priorRankCol} IS NOT NULL`);
    out.push(...rangePredicates(priorRankCol, m.prior, next));
    out.push(...rangePredicates('kcs.current_rank', m.current, next));
  } else {
    // The contract guarantees exactly one prior lower bound and a current upper bound here.
    out.push(...rangePredicates(priorRankCol, m.prior, next).map((p) => `(${p} OR ${priorRankCol} IS NULL)`));
    out.push(...rangePredicates('kcs.current_rank', m.current, next));
  }
  return out;
}

export function compileSearch(input: CompileInput): CompiledSearch {
  const { filters: f, sort, window } = input;
  const args: unknown[] = [];
  const next: NextParam = (v) => { args.push(v); return `$${args.length}`; };

  const where: string[] = [`kcs.current_week_end_date = ${next(input.currentWeekEndDate)}::date`];
  where.push(...rangePredicates('kcs.estimated_monthly_volume_current', f.estimatedMonthlySearches, next));
  where.push(...rangePredicates('kcs.avg_reviews', f.averageReviews, next));
  where.push(...rangePredicates('kcs.current_rank', f.rank, next));
  where.push(...rangePredicates('kcs.word_count', f.wordCount, next));
  if (f.text) {
    where.push(f.text.mode === 'broad'
      ? `kcs.search_term_normalized LIKE ${next(broadPattern(f.text.value))}`
      : `kcs.search_term_normalized ~ ${next(wordPattern(f.text.value))}`);
  }
  if (f.broadCategory) where.push(`kcs.top_clicked_category_1_current = ${next(f.broadCategory)}`);
  const leaf = leafPathPredicate({ leafPaths: input.leaves }, next);
  if (leaf) where.push(leaf);
  // Movement's own bound params (prior/current/delta) are bound here, BEFORE severity's fixed
  // default predicate below, so they claim the lowest available $N. severities defaults to
  // ['none', 'warning'] (never empty — see contracts.ts), so severityPredicate almost always
  // binds two params of its own; if movement ran after it, every movement bound would be
  // shifted by two params for no reason tied to the request itself.
  if (f.movement) where.push(...movementPredicates(f.movement, next));
  const sev = severityPredicate({ severities: f.severities }, next);
  if (sev) where.push(sev);
  if (f.titleGap) {
    const mode = f.titleGap.mode;
    const conds = f.titleGap.slots.map((s) => `${slotColumn(s, mode)} = false`);
    where.push(`(${conds.join(f.titleGap.quantifier === 'all' ? ' AND ' : ' OR ')})`);
  }
  // Only when there's no movement filter: a bare volumeDelta sort still needs the eligibility
  // guard (movement's own volume-metric branch above already includes it — never both). This
  // predicate binds no args, so it can stay last without disturbing any $N numbering; kept last
  // so it stays immediately adjacent to ORDER BY when nothing else follows it.
  if (!f.movement && sort.field === 'volumeDelta') where.push(`(${volumeDeltaEligibility(window, 'kcs.')})`);

  const whereClause = `WHERE ${where.join('\n        AND ')}`;
  const countArgs = [...args];
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT 1
      FROM keyword_current_summary kcs
      ${whereClause}
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `.trim();

  const orderBy = orderByFor(sort, window);
  const limitParam = next(input.limit);
  const offsetParam = next(input.offset);
  const priorRankCol = WINDOW_TO_RANK_COLUMN[window];
  const priorVolCol = WINDOW_TO_VOLUME_COLUMN[window];
  const sql = `
    SELECT
      kcs.search_term_id,
      st.search_term_raw,
      st.first_seen_week::text AS first_seen_week,
      kcs.last_seen_week::text AS last_seen_week,
      kcs.current_rank,
      kcs.estimated_monthly_volume_current::text AS estimated_monthly_volume_current,
      kcs.avg_reviews,
      kcs.word_count,
      kcs.top_clicked_category_path,
      kcs.top_clicked_category_1_current,
      kcs.fake_volume_severity_current::text AS fake_volume_severity_current,
      kcs.${priorRankCol} AS prior_rank,
      kcs.${priorVolCol}::text AS prior_volume_raw,
      (${volumeDeltaExpr(window, 'kcs.')})::text AS volume_delta,
      kcs.keyword_in_title_1_loose_current, kcs.keyword_in_title_2_loose_current, kcs.keyword_in_title_3_loose_current,
      kcs.keyword_in_title_1_current, kcs.keyword_in_title_2_current, kcs.keyword_in_title_3_current
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();
  return { sql, args, countSql, countArgs, orderBy };
}

export interface RawSearchRow {
  search_term_id: string; search_term_raw: string; first_seen_week: string; last_seen_week: string; current_rank: number;
  estimated_monthly_volume_current: string | null; avg_reviews: number | null; word_count: number | null;
  top_clicked_category_path: string | null; top_clicked_category_1_current: string | null; fake_volume_severity_current: string | null;
  prior_rank: number | null; prior_volume_raw: string | null; volume_delta: string | null;
  keyword_in_title_1_loose_current: boolean | null; keyword_in_title_2_loose_current: boolean | null; keyword_in_title_3_loose_current: boolean | null;
  keyword_in_title_1_current: boolean | null; keyword_in_title_2_current: boolean | null; keyword_in_title_3_current: boolean | null;
}
export interface RowContext { appUrl: string; window: Window; includeMovement: boolean; titleMode: 'loose' | 'strict' | null }

const toInt = (v: string | null): number | null => (v === null ? null : parseInt(v, 10));

export function mapSearchRow(r: RawSearchRow, ctx: RowContext): SearchRow {
  const row: SearchRow = {
    searchTermId: r.search_term_id,
    keyword: r.search_term_raw,
    keywordUrl: `${ctx.appUrl.replace(/\/+$/, '')}/explorer/keyword/${r.search_term_id}`,
    estimatedMonthlySearches: toInt(r.estimated_monthly_volume_current),
    averageReviews: r.avg_reviews,
    rank: r.current_rank,
    wordCount: r.word_count,
    categoryPath: r.top_clicked_category_path,
    broadCategory: r.top_clicked_category_1_current,
    severity: (r.fake_volume_severity_current as Severity | null) ?? null,
    lastSeenWeek: r.last_seen_week.slice(0, 10),
    firstSeenWeek: r.first_seen_week.slice(0, 10),
  };
  if (ctx.includeMovement) {
    const baselineStatus: BaselineStatus = r.prior_rank === null ? 'not_observed' : r.prior_volume_raw === null ? 'calibration_unavailable' : 'observed';
    row.movement = {
      window: ctx.window,
      priorRank: r.prior_rank,
      priorVolume: baselineStatus === 'observed' ? toInt(r.prior_volume_raw) : baselineStatus === 'not_observed' ? 0 : null,
      volumeDelta: baselineStatus === 'calibration_unavailable' ? null : toInt(r.volume_delta),
      baselineStatus,
    };
  }
  if (ctx.titleMode) {
    row.titleFlags = ctx.titleMode === 'loose'
      ? { mode: 'loose', slots: [r.keyword_in_title_1_loose_current, r.keyword_in_title_2_loose_current, r.keyword_in_title_3_loose_current] }
      : { mode: 'strict', slots: [r.keyword_in_title_1_current, r.keyword_in_title_2_current, r.keyword_in_title_3_current] };
  }
  return row;
}
