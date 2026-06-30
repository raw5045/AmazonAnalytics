import { pgTable, uuid, text, integer, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Per-category-path counts precomputed during the kcs stage-and-swap.
 *
 * Mirrors the broad-category facets table (see migration 0021 +
 * keywordCurrentSummaryCategoryFacets) but groups by the full Keepa
 * category path of the slot-1 (most-clicked) ASIN. Powers the
 * category-path dropdown filter in the explorer sidebar.
 *
 * See migration 0029 + 0039.
 */
export const keywordCurrentSummaryLeafCategoryFacets = pgTable(
  'keyword_current_summary_leaf_category_facets',
  {
    snapshotVersion: uuid('snapshot_version').notNull(),
    categoryPath: text('category_path').notNull(),
    /** kcs rows in this category path with severity matching the default explorer filter. */
    defaultSeverityCount: integer('default_severity_count').notNull(),
    /** Total kcs row count for this category path, all severities. */
    allCount: integer('all_count').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotVersion, t.categoryPath] }),
    snapshotIdx: index('kcs_leaf_facets_snapshot_idx').on(t.snapshotVersion),
  }),
);

/** One precomputed facet row keyed by full Keepa category path. */
export type KeywordCurrentSummaryLeafCategoryFacet =
  typeof keywordCurrentSummaryLeafCategoryFacets.$inferSelect;
