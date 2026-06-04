/**
 * Types for the keyword explorer (Plan 3.2).
 *
 * The explorer is read-only: it queries keyword_current_summary + search_terms
 * and returns a paged list of keywords matching the filter set.
 */

export type WindowKey = '1w' | '4w' | '13w' | '26w' | '52w';

export type SortKey =
  | 'rank' | 'rank_desc'
  | 'imp' | 'decline'
  | 'title_gap'
  | 'avg_price_asc' | 'avg_price_desc'
  | 'avg_reviews_asc' | 'avg_reviews_desc'
  | 'vol_4w_asc' | 'vol_4w_desc'
  | 'vol_13w_asc' | 'vol_13w_desc'
  | 'vol_26w_asc' | 'vol_26w_desc'
  | 'vol_52w_asc' | 'vol_52w_desc'
  | 'added_asc' | 'added_desc';

export type SeverityKey = 'none' | 'warning' | 'critical';

export type JumpKey =
  | '500k_to_100k'
  | '100k_to_50k'
  | '100k_to_10k'
  | '50k_to_10k'
  /** Custom threshold pair — user-entered `jumpFrom` and `jumpTo`. */
  | 'custom';

export type TitleMatchMode = 'any' | 'all';

/**
 * Which definition of "keyword in title" we use for both the
 * in-title icons in the results table and the title-gap WHERE clause:
 *
 *   - 'strict' = the flags Amazon ships in the SFR CSV (exact phrase)
 *   - 'loose'  = our computed flag — every non-stopword token appears
 *                somewhere in the title (word-boundary match)
 *
 * Default is 'loose' since it more often matches user expectations
 * ("Creatine Gummies" → "Creatine Monohydrate Gummies" should count).
 */
export type MatchMode = 'strict' | 'loose';

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
  volume4wAgoMin: number | null;
  volume4wAgoMax: number | null;
  volume13wAgoMin: number | null;
  volume13wAgoMax: number | null;
  volume26wAgoMin: number | null;
  volume26wAgoMax: number | null;
  volume52wAgoMin: number | null;
  volume52wAgoMax: number | null;
  jump: JumpKey | null;
  /** Only consulted when jump === 'custom'. The "was ranked worse than" threshold. */
  jumpFrom: number | null;
  /** Only consulted when jump === 'custom'. The "now ranked better than" threshold. */
  jumpTo: number | null;
  category: string | null;
  /**
   * Keepa leaf categories (e.g. ["Face Moisturizers", "Anti-aging Creams"])
   * for the slot-1 top-clicked ASIN. Independent from `category` (the
   * broad BA cat). Multi-select with OR semantics — a keyword matches
   * if its leaf is in this list. Empty array = no leaf filter.
   *
   * Precursor for saved-searches with custom leaf-set filters.
   */
  leafCategories: string[];
  severities: SeverityKey[];
  titleSlots: number[];
  titleMatchMode: TitleMatchMode | null;
  matchMode: MatchMode;
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
  // Strict (Amazon-shipped) and loose (our computed) flags + counts.
  // The UI picks which to display based on filters.matchMode.
  keywordTitleMatchCount: number | null;
  keywordInTitle1: boolean | null;
  keywordInTitle2: boolean | null;
  keywordInTitle3: boolean | null;
  keywordTitleMatchCountLoose: number | null;
  keywordInTitle1Loose: boolean | null;
  keywordInTitle2Loose: boolean | null;
  keywordInTitle3Loose: boolean | null;
  topClickedProduct1Asin: string | null;
  topClickedProduct1Title: string | null;
  topClickedProduct1ClickShare: string | null;
  topClickedProduct1ConversionShare: string | null;
  /**
   * Precomputed estimated monthly search volume from the rank-to-
   * volume model fit selected by pickFitForWeek at refresh time.
   * NULL only when no calibration fit existed when the kcs snapshot
   * was built. See migration 0027.
   */
  estimatedMonthlyVolumeCurrent: number | null;
  estimatedMonthlyVolume4wAgo: number | null;
  estimatedMonthlyVolume13wAgo: number | null;
  estimatedMonthlyVolume26wAgo: number | null;
  estimatedMonthlyVolume52wAgo: number | null;
  /**
   * Keepa-derived aggregates over the top-3 clicked ASINs at the
   * current week. NULL when all 3 ASINs are unenriched. See
   * migrations 0029 (ranges, no longer displayed) + 0030 (averages).
   */
  avgPriceCents: number | null;
  avgReviews: number | null;
  /** Keepa leaf category of the slot-1 ASIN. NULL if not enriched. */
  topClickedLeafCategory: string | null;
}

/**
 * One-shot info about the volume-model fit that produced every
 * estimated_monthly_volume_current value in the current explorer
 * snapshot. The explorer reads this from `keyword_current_summary_meta`
 * and renders a single page-level chip — there is nothing per-row to
 * render (every row uses the same fit).
 *
 * `null` when no fit was selected at refresh time (cold start).
 */
export interface VolumeFitMeta {
  calibrationMonthEndDate: string;
  isExtrapolated: boolean;
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
