/**
 * Lists distinct top-clicked categories present in keyword_current_summary,
 * for the category dropdown in FilterSidebar.
 *
 * Reads from `keyword_current_summary_category_facets`, populated
 * during the kcs stage-and-swap (see migration 0021 + refreshSummary).
 * One row per category — typically ~100 rows total. The query is a
 * single index lookup keyed by the current snapshot_version.
 *
 * Replaces a previous `SELECT DISTINCT … FROM kcs` scan over ~3.9M
 * rows, which cost ~5290ms cold and was the dominant cold-load
 * bottleneck per the perf RFC.
 *
 * Fallback: if the facets table is empty or the meta row is missing
 * (e.g. immediately after a fresh migration before the first refresh),
 * fall back to the original DISTINCT scan so the dropdown is never
 * empty.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';

async function fetchCategories(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);

  // Fast path: read pre-aggregated rows from facets, keyed by the
  // current snapshot_version on meta. Two small queries (meta then
  // facets) but both are single-row PK lookups → tens of ms even cold.
  try {
    const meta = (await sql`
      SELECT snapshot_version::text AS sv
      FROM keyword_current_summary_meta
      WHERE singleton = true
    `) as Array<{ sv: string | null }>;
    const sv = meta[0]?.sv;
    if (sv) {
      const rows = (await sql`
        SELECT category
        FROM keyword_current_summary_category_facets
        WHERE snapshot_version = ${sv}::uuid
        ORDER BY category
      `) as Array<{ category: string }>;
      if (rows.length > 0) {
        return rows.map((r) => r.category);
      }
    }
  } catch {
    // Fall through to legacy path on any error.
  }

  // Legacy fallback: DISTINCT scan over kcs. Slow on cold, but always
  // correct and never returns empty for a populated kcs.
  const rows = (await sql`
    SELECT DISTINCT top_clicked_category_1_current AS category
    FROM keyword_current_summary
    WHERE top_clicked_category_1_current IS NOT NULL
    ORDER BY top_clicked_category_1_current
  `) as Array<{ category: string }>;
  return rows.map((r) => r.category);
}

export const listCategories = unstable_cache(fetchCategories, ['explorer-categories'], {
  revalidate: 60 * 60, // 1 hour
  tags: ['explorer-categories'],
});
