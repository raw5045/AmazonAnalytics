import { pgTable, uuid, text, integer, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Per-category counts precomputed during the kcs stage-and-swap.
 *
 * Replaces two cold-slow queries with single-digit-ms reads:
 *
 *   1. listCategories — the cold-load villain at ~5290ms (DISTINCT
 *      scan over ~3.9M kcs rows). Becomes a small `SELECT category
 *      FROM facets WHERE snapshot_version = $1 ORDER BY category`.
 *
 *   2. Category-only explorer COUNT — the cold-load villain at
 *      ~7700ms when a category filter is applied. Becomes a single
 *      PK lookup against (snapshot_version, category).
 *
 * Keyed by snapshot_version so old + new snapshots can briefly
 * coexist during a kcs swap. Populated atomically alongside the kcs
 * swap in refreshSummary.
 *
 * See migration 0021.
 */
export const keywordCurrentSummaryCategoryFacets = pgTable(
  'keyword_current_summary_category_facets',
  {
    snapshotVersion: uuid('snapshot_version').notNull(),
    category: text('category').notNull(),
    /**
     * Count of kcs rows in this category whose severity matches the
     * default explorer filter (NULL / none / warning).
     */
    defaultSeverityCount: integer('default_severity_count').notNull(),
    /**
     * Total kcs row count for this category, all severities. Reserved
     * for future severity-aware count short-circuits.
     */
    allCount: integer('all_count').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotVersion, t.category] }),
    snapshotIdx: index('kcs_facets_snapshot_idx').on(t.snapshotVersion),
  }),
);

export type KeywordCurrentSummaryCategoryFacet =
  typeof keywordCurrentSummaryCategoryFacets.$inferSelect;
