import { pgTable, uuid, text, integer, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Per-leaf-category counts precomputed during the kcs stage-and-swap.
 *
 * Mirrors the broad-category facets table (see migration 0021 +
 * keywordCurrentSummaryCategoryFacets) but groups by the Keepa-derived
 * leaf category of the slot-1 (most-clicked) ASIN. Powers the
 * "leaf category" dropdown filter in the explorer sidebar.
 *
 * See migration 0029.
 */
export const keywordCurrentSummaryLeafCategoryFacets = pgTable(
  'keyword_current_summary_leaf_category_facets',
  {
    snapshotVersion: uuid('snapshot_version').notNull(),
    leafCategory: text('leaf_category').notNull(),
    /** kcs rows in this leaf with severity matching the default explorer filter. */
    defaultSeverityCount: integer('default_severity_count').notNull(),
    /** Total kcs row count for this leaf, all severities. */
    allCount: integer('all_count').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotVersion, t.leafCategory] }),
    snapshotIdx: index('kcs_leaf_facets_snapshot_idx').on(t.snapshotVersion),
  }),
);

export type KeywordCurrentSummaryLeafCategoryFacet =
  typeof keywordCurrentSummaryLeafCategoryFacets.$inferSelect;
