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
  // TEMP perf instrumentation (cold-start diagnosis) — remove after measuring.
  const tMeta0 = performance.now();
  const sql = neon(env.DATABASE_URL);
  const meta = (await sql`
    SELECT snapshot_version::text AS sv, current_week_end_date::text AS wk
    FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ sv: string | null; wk: string | null }>;
  const tMeta1 = performance.now();
  const sv = meta[0]?.sv ?? null;
  const wk = meta[0]?.wk ?? null;
  if (!wk) return { snapshotVersion: sv, tree: [] };
  const result = await buildCachedTree(sv ?? 'no-snapshot', wk);
  console.log(
    `[cb perf] meta ${(tMeta1 - tMeta0).toFixed(0)}ms · treeCache ${(performance.now() - tMeta1).toFixed(0)}ms`,
  );
  return result;
}

// Keyed by (sv, wk) — unstable_cache varies its entry by the args, so a new
// snapshot_version rebuilds immediately; revalidate is a backstop.
const buildCachedTree = unstable_cache(
  async (_sv: string, wk: string): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> => {
    // TEMP: this body only runs on a cache MISS — logging it tells us whether
    // the tree is being cached at all (cold-start diagnosis). Remove after.
    const tStart = performance.now();
    console.log('[cb perf] tree cache MISS — rebuilding (DISTINCT scan + buildTree)');
    const sql = neon(env.DATABASE_URL);
    const rows = (await sql`
      SELECT DISTINCT category_path
      FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND category_path IS NOT NULL AND category_path <> ''
    `) as Array<{ category_path: string }>;
    const tQuery = performance.now();
    const tree = buildTree(rows.map((r) => r.category_path));
    console.log(
      `[cb perf] rebuild: query ${(tQuery - tStart).toFixed(0)}ms · build ${(performance.now() - tQuery).toFixed(0)}ms · ${rows.length} paths`,
    );
    return { snapshotVersion: _sv === 'no-snapshot' ? null : _sv, tree };
  },
  ['category-builder-tree'],
  { revalidate: 60 * 60 * 24, tags: ['category-builder-tree'] },
);

export async function loadCategoryTree(): Promise<{ snapshotVersion: string | null; tree: CategoryNode[] }> {
  return fetchTree();
}
