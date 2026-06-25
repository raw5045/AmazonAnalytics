/**
 * Builds + caches Category Builder data from asin_weekly_data.category_path for
 * the current snapshot's week. Cached by snapshot_version, so a weekly refresh
 * (which mints a new snapshot_version) transparently rebuilds it.
 *
 * Two loaders:
 *  - loadRootDepartments(): the ~30 top-level departments only (LightNode[]).
 *    Computed directly in SQL and tiny to cache — used by the initial page
 *    render. Avoids materializing the full ~808 KB tree just to show 30 roots.
 *  - loadCategoryTree(): the full nested tree. Used by the drill-down API
 *    routes that need to walk to an arbitrary path.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { buildTree, type CategoryNode } from './buildTree';
import { type LightNode } from './treeNav';

async function getSnapshotMeta(): Promise<{ sv: string | null; wk: string | null }> {
  const sql = neon(env.DATABASE_URL);
  const meta = (await sql`
    SELECT snapshot_version::text AS sv, current_week_end_date::text AS wk
    FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ sv: string | null; wk: string | null }>;
  return { sv: meta[0]?.sv ?? null, wk: meta[0]?.wk ?? null };
}

// ---- Root departments: the cheap path for the initial page render ----

const buildCachedRoots = unstable_cache(
  async (
    _sv: string,
    wk: string,
  ): Promise<{ snapshotVersion: string | null; rootLevel: LightNode[] }> => {
    const sql = neon(env.DATABASE_URL);
    // Compute the ~30 roots in one scan (~1 KB result) instead of building the
    // full 808 KB tree to extract the top level. name/hasChildren/terminal match
    // buildTree's root level exactly (verified against prod); sorted in JS to
    // match buildTree's locale-aware ordering.
    const rows = (await sql`
      SELECT
        split_part(category_path, ' › ', 1) AS name,
        bool_or(category_path = split_part(category_path, ' › ', 1)) AS terminal,
        bool_or(position(' › ' in category_path) > 0) AS has_children
      FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND category_path IS NOT NULL AND category_path <> ''
      GROUP BY 1
    `) as Array<{ name: string; terminal: boolean; has_children: boolean }>;
    const rootLevel: LightNode[] = rows
      .map((r) => ({ name: r.name, hasChildren: r.has_children, terminal: r.terminal }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { snapshotVersion: _sv === 'no-snapshot' ? null : _sv, rootLevel };
  },
  ['category-builder-roots'],
  { revalidate: 60 * 60 * 24, tags: ['category-builder-tree'] },
);

export async function loadRootDepartments(): Promise<{
  snapshotVersion: string | null;
  rootLevel: LightNode[];
}> {
  const { sv, wk } = await getSnapshotMeta();
  if (!wk) return { snapshotVersion: sv, rootLevel: [] };
  return buildCachedRoots(sv ?? 'no-snapshot', wk);
}

// ---- Full tree: used by the drill-down API routes (tree / leaves) ----

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
  const { sv, wk } = await getSnapshotMeta();
  if (!wk) return { snapshotVersion: sv, tree: [] };
  return buildCachedTree(sv ?? 'no-snapshot', wk);
}
