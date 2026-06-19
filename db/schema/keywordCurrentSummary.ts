import { pgTable, uuid, integer, bigint, date, varchar, text, boolean, smallint, timestamp, numeric, index } from 'drizzle-orm/pg-core';
import { searchTerms } from './searchTerms';
import { fakeVolumeSeverityEnum } from './uploads';

/**
 * Denormalized "current snapshot" of every currently-active keyword.
 *
 * One row per `search_term_id`, refreshed after every successful weekly
 * import (the `summary_refresh` phase of processFileImport).
 *
 * "Currently-active" = last_seen_week >= current_week_end_date - 28 days.
 * Long-dormant terms drop out of this table to keep explorer queries fast
 * (~4M active rows vs. ~9.3M total in search_terms). Detail page and
 * substring search still hit kwm / search_terms directly so dormant terms
 * remain queryable when explicitly asked for.
 *
 * Refresh is rebuilt from scratch (TRUNCATE + INSERT) on each import.
 * Estimated cost: 5-8 min on ~4M active terms.
 */
export const keywordCurrentSummary = pgTable(
  'keyword_current_summary',
  {
    searchTermId: uuid('search_term_id').primaryKey().references(() => searchTerms.id),
    currentWeekEndDate: date('current_week_end_date').notNull(),
    currentRank: integer('current_rank').notNull(),

    /**
     * Denormalized normalized keyword text (copied from search_terms during
     * refresh) so the explorer "search term contains" filter — whole-word
     * (regex) and broad (LIKE) — runs single-table on the active set via a
     * GIN trigram index, instead of joining/probing all-time search_terms.
     * Nullable so the column can be added + backfilled before the refresh
     * populates it. The GIN index is NOT declared here (drizzle-kit doesn't
     * emit GIN trgm) — it's built one-shot post-populate by the backfill +
     * weekly refresh. See migration 0037 + explorer-filter-perf spec v2.
     */
    searchTermNormalized: varchar('search_term_normalized', { length: 512 }),

    // Historical comparison ranks (NULL = unranked or no data that far back)
    priorWeekRank: integer('prior_week_rank'),
    rank4wAgo: integer('rank_4w_ago'),
    rank13wAgo: integer('rank_13w_ago'),
    rank26wAgo: integer('rank_26w_ago'),
    rank52wAgo: integer('rank_52w_ago'),

    // improvement_Nw = rank_Nw_ago - current_rank (positive = improvement)
    improvement1w: integer('improvement_1w'),
    improvement4w: integer('improvement_4w'),
    improvement13w: integer('improvement_13w'),
    improvement26w: integer('improvement_26w'),
    improvement52w: integer('improvement_52w'),

    consecutiveImprovementStreak: integer('consecutive_improvement_streak').notNull().default(0),
    everTop50k: boolean('ever_top_50k').notNull().default(false),
    hasUnrankedWeek: boolean('has_unranked_week').notNull().default(false),
    unrankedWeekCount: integer('unranked_week_count').notNull().default(0),
    unrankedAfterTop50k: boolean('unranked_after_top_50k').notNull().default(false),

    lastSeenWeek: date('last_seen_week').notNull(),
    weeksSinceSeen: integer('weeks_since_seen').notNull().default(0),

    fakeVolumeSeverityCurrent: fakeVolumeSeverityEnum('fake_volume_severity_current'),

    // "Currently looks like" snapshot from the latest observed week
    topClickedCategory1Current: varchar('top_clicked_category_1_current', { length: 255 }),
    topClickedProduct1AsinCurrent: varchar('top_clicked_product_1_asin_current', { length: 20 }),
    topClickedProduct1TitleCurrent: text('top_clicked_product_1_title_current'),
    topClickedProduct1ClickShareCurrent: numeric('top_clicked_product_1_click_share_current', { precision: 5, scale: 2 }),
    topClickedProduct1ConversionShareCurrent: numeric('top_clicked_product_1_conversion_share_current', { precision: 5, scale: 2 }),
    keywordInTitle1Current: boolean('keyword_in_title_1_current'),
    keywordInTitle2Current: boolean('keyword_in_title_2_current'),
    keywordInTitle3Current: boolean('keyword_in_title_3_current'),
    keywordTitleMatchCountCurrent: smallint('keyword_title_match_count_current'),

    // "Loose" match flags computed by refreshKeywordCurrentSummary:
    // every non-stopword token in the search term must appear (with
    // word-boundary regex match, case-insensitive) anywhere in the
    // title — order doesn't matter and intervening words are allowed.
    // Distinct from the strict flags above (which come straight from
    // Amazon's CSV and require an exact phrase match).
    keywordInTitle1LooseCurrent: boolean('keyword_in_title_1_loose_current'),
    keywordInTitle2LooseCurrent: boolean('keyword_in_title_2_loose_current'),
    keywordInTitle3LooseCurrent: boolean('keyword_in_title_3_loose_current'),
    keywordTitleMatchCountLooseCurrent: smallint('keyword_title_match_count_loose_current'),

    // top_category_changed_recently / top_asin_changed_recently DEFERRED
    // (Plan 3.1 review 2026-05-01 — low expected signal in low-volume
    // keywords; add later via ALTER TABLE if user demand emerges)

    /**
     * Precomputed estimated monthly Amazon search volume for this
     * keyword at the current week, derived from the rank-to-volume
     * power-law fit selected by pickFitForWeek(current_week_end_date,
     * fits). NULL when no calibration fit exists at all.
     *
     * Refreshed atomically with the rest of kcs (see refreshSummary).
     * Detail page computes per-historical-week values at render time
     * instead — this column only covers the current week.
     */
    estimatedMonthlyVolumeCurrent: bigint('estimated_monthly_volume_current', { mode: 'number' }),

    // Lookback estimated monthly volume at the same horizons kcs stores
    // ranks (computed in refreshSummary from rank_Nw_ago + the fit for
    // that horizon's week). NULL when no fit exists or rank is NULL.
    estimatedMonthlyVolume4wAgo: bigint('estimated_monthly_volume_4w_ago', { mode: 'number' }),
    estimatedMonthlyVolume13wAgo: bigint('estimated_monthly_volume_13w_ago', { mode: 'number' }),
    estimatedMonthlyVolume26wAgo: bigint('estimated_monthly_volume_26w_ago', { mode: 'number' }),
    estimatedMonthlyVolume52wAgo: bigint('estimated_monthly_volume_52w_ago', { mode: 'number' }),
    estimatedMonthlyVolume1wAgo: bigint('estimated_monthly_volume_1w_ago', { mode: 'number' }),

    /**
     * Keepa-derived aggregates over the top-3 clicked ASINs at the
     * current week. NULL when all 3 ASINs are unenriched. See
     * migrations 0029 (ranges) + 0030 (averages).
     */
    lowestPriceCents: bigint('lowest_price_cents', { mode: 'number' }),
    highestPriceCents: bigint('highest_price_cents', { mode: 'number' }),
    leastReviews: integer('least_reviews'),
    mostReviews: integer('most_reviews'),
    /** Mean price across top-3 ASINs (NULL-tolerant). */
    avgPriceCents: bigint('avg_price_cents', { mode: 'number' }),
    /** Mean review_count across top-3 ASINs (NULL-tolerant). */
    avgReviews: integer('avg_reviews'),
    /** Keepa leaf category for the slot-1 (most-clicked) ASIN. */
    topClickedLeafCategory: text('top_clicked_leaf_category'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rankIdx: index('kcs_rank_idx').on(t.currentWeekEndDate, t.currentRank),
    titleMatchIdx: index('kcs_title_match_idx').on(t.currentWeekEndDate, t.keywordTitleMatchCountCurrent),
    titleMatchLooseIdx: index('kcs_title_match_loose_idx').on(t.currentWeekEndDate, t.keywordTitleMatchCountLooseCurrent),
    imp1Idx: index('kcs_imp1_idx').on(t.improvement1w),
    imp4Idx: index('kcs_imp4_idx').on(t.improvement4w),
    imp13Idx: index('kcs_imp13_idx').on(t.improvement13w),
    imp26Idx: index('kcs_imp26_idx').on(t.improvement26w),
    imp52Idx: index('kcs_imp52_idx').on(t.improvement52w),
    categoryIdx: index('kcs_category_idx').on(t.currentWeekEndDate, t.topClickedCategory1Current),
    severityIdx: index('kcs_severity_idx').on(t.currentWeekEndDate, t.fakeVolumeSeverityCurrent),
    // Composite indexes powering threshold-jump filters
    // ("rank_Nw_ago > X AND current_rank < Y"). Plan 3.2 §8.
    jump4wIdx: index('kcs_jump_4w_idx').on(t.rank4wAgo, t.currentRank),
    jump13wIdx: index('kcs_jump_13w_idx').on(t.rank13wAgo, t.currentRank),
    jump26wIdx: index('kcs_jump_26w_idx').on(t.rank26wAgo, t.currentRank),
    jump52wIdx: index('kcs_jump_52w_idx').on(t.rank52wAgo, t.currentRank),
    estVolIdx: index('kcs_est_vol_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolumeCurrent),
    estVol4wIdx: index('kcs_est_vol_4w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume4wAgo),
    estVol13wIdx: index('kcs_est_vol_13w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume13wAgo),
    estVol26wIdx: index('kcs_est_vol_26w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume26wAgo),
    estVol52wIdx: index('kcs_est_vol_52w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume52wAgo),
    estVol1wIdx: index('kcs_est_vol_1w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume1wAgo),
    leafCategoryIdx: index('kcs_leaf_category_idx').on(t.currentWeekEndDate, t.topClickedLeafCategory),
    lowestPriceIdx: index('kcs_lowest_price_idx').on(t.currentWeekEndDate, t.lowestPriceCents),
    mostReviewsIdx: index('kcs_most_reviews_idx').on(t.currentWeekEndDate, t.mostReviews),
    avgPriceIdx: index('kcs_avg_price_idx').on(t.currentWeekEndDate, t.avgPriceCents),
    avgReviewsIdx: index('kcs_avg_reviews_idx').on(t.currentWeekEndDate, t.avgReviews),
  }),
);

export type KeywordCurrentSummary = typeof keywordCurrentSummary.$inferSelect;
export type NewKeywordCurrentSummary = typeof keywordCurrentSummary.$inferInsert;
