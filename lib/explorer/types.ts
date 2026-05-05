/**
 * Types for the keyword explorer (Plan 3.2).
 *
 * The explorer is read-only: it queries keyword_current_summary + search_terms
 * and returns a paged list of keywords matching the filter set.
 */

export type WindowKey = '1w' | '4w' | '13w' | '26w' | '52w';

export type SortKey = 'rank' | 'rank_desc' | 'imp' | 'decline' | 'title_gap';

export type SeverityKey = 'none' | 'warning' | 'critical';

export type JumpKey = '500k_to_100k' | '100k_to_50k' | '100k_to_10k' | '50k_to_10k';

export type TitleMatchMode = 'any' | 'all';

/**
 * The full set of filters/sort/pagination state for the explorer page.
 * All fields have defaults — `parseFilters` produces a fully-populated
 * object even from an empty searchParams.
 */
export interface ExplorerFilters {
  window: WindowKey;
  q: string | null;
  rankMin: number | null;
  rankMax: number | null;
  jump: JumpKey | null;
  category: string | null;
  severities: SeverityKey[];
  titleSlots: number[];
  titleMatchMode: TitleMatchMode | null;
  sort: SortKey;
  page: number;
  perPage: number;
}

/**
 * One row of explorer results.
 * Shared between the table renderer and any future export.
 */
export interface ExplorerRow {
  searchTermId: string;
  searchTermRaw: string;
  currentRank: number;
  priorRank: number | null;
  improvement: number | null;
  topClickedCategory1: string | null;
  fakeVolumeSeverity: SeverityKey | null;
  keywordTitleMatchCount: number | null;
  keywordInTitle1: boolean | null;
  keywordInTitle2: boolean | null;
  keywordInTitle3: boolean | null;
  topClickedProduct1Asin: string | null;
  topClickedProduct1Title: string | null;
  topClickedProduct1ClickShare: string | null;
  topClickedProduct1ConversionShare: string | null;
}

/**
 * Output of buildExplorerQuery: the SQL pieces ready for pg.query().
 *
 * sql + args run the paged SELECT.
 * countSql + countArgs run the matching COUNT(*) for pagination footer.
 *
 * countArgs is a strict prefix of args (the WHERE-clause args; sql appends
 * LIMIT/OFFSET as the last two args).
 */
export interface BuiltExplorerQuery {
  sql: string;
  args: unknown[];
  countSql: string;
  countArgs: unknown[];
}
