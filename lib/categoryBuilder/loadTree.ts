/**
 * Builds + caches the Category Builder tree from asin_weekly_data.category_path
 * for the current snapshot's week. Cached by snapshot_version, so a weekly
 * refresh (which mints a new snapshot_version) transparently rebuilds it.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { buildTree, type CategoryNode } from './buildTree';

async function fetchTree(): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> {
  const sql = neon(env.DATABASE_URL);
  const meta = (await sql`
    SELECT snapshot_version::text AS sv, current_week_end_date::text AS wk
    FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ sv: string | null; wk: string | null }>;
  const sv = meta[0]?.sv ?? null;
  const wk = meta[0]?.wk ?? null;
  if (!wk) return { snapshotVersion: sv, tree: [] };
  return buildCachedTree(sv ?? 'no-snapshot', wk);
}

// Keyed by (sv, wk) — unstable_cache varies its entry by the args, so a new
// snapshot_version rebuilds immediately; revalidate is a backstop.
const buildCachedTree = unstable_cache(
  async (_sv: string, wk: string): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> => {
    const sql = neon(env.DATABASE_URL);
    const rows = (await sql`
      SELECT DISTINCT category_path
      FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND category_path IS NOT NULL AND category_path <> ''
    `) as Array<{ category_path: string }>;
    return { snapshotVersion: _sv === 'no-snapshot' ? null : _sv, tree: buildTree(rows.map((r) => r.category_path)) };
  },
  ['category-builder-tree'],
  { revalidate: 60 * 60 * 24, tags: ['category-builder-tree'] },
);

export async function loadCategoryTree(): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> {
  return fetchTree();
}
