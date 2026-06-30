/**
 * Lists distinct Keepa leaf categories present in keyword_current_summary,
 * for the new leaf-category dropdown in FilterSidebar.
 *
 * Same pattern as listCategories (broad cat) but reads from
 * keyword_current_summary_leaf_category_facets — populated atomically
 * with the kcs stage-and-swap (see migration 0029 + refreshSummary).
 *
 * Typically ~500-2000 rows (Keepa's leaf taxonomy is much finer than
 * the BA broad cat). Single index lookup keyed by current
 * snapshot_version — tens of ms even cold.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';

async function fetchLeafCategories(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  try {
    const meta = (await sql`
      SELECT snapshot_version::text AS sv
      FROM keyword_current_summary_meta
      WHERE singleton = true
    `) as Array<{ sv: string | null }>;
    const sv = meta[0]?.sv;
    if (sv) {
      const rows = (await sql`
        SELECT category_path
        FROM keyword_current_summary_leaf_category_facets
        WHERE snapshot_version = ${sv}::uuid
        ORDER BY category_path
      `) as Array<{ category_path: string }>;
      if (rows.length > 0) {
        return rows.map((r) => r.category_path);
      }
    }
  } catch {
    // Fall through to legacy path on any error.
  }

  // Legacy fallback: DISTINCT scan over kcs. Slow on cold, but never
  // returns empty for a populated kcs (e.g. immediately after migration
  // before the first refresh).
  const rows = (await sql`
    SELECT DISTINCT top_clicked_category_path AS category_path
    FROM keyword_current_summary
    WHERE top_clicked_category_path IS NOT NULL
    ORDER BY top_clicked_category_path
  `) as Array<{ category_path: string }>;
  return rows.map((r) => r.category_path);
}

export const listLeafCategories = unstable_cache(fetchLeafCategories, ['explorer-leaf-categories-v2'], {
  revalidate: 60 * 60, // 1 hour
  tags: ['explorer-leaf-categories'],
});
