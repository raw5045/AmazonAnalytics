/**
 * Category Builder data, loaded per-level from asin_weekly_data.category_path for
 * the current snapshot's week and cached by snapshot_version (a weekly refresh
 * mints a new snapshot_version, transparently rebuilding the cache).
 *
 * Everything is computed in SQL at the granularity the UI needs — root
 * departments, the children at a path, or the leaves under a path — so we never
 * materialize the full ~808 KB / 14,739-node tree just to render one level.
 *
 *  - loadRootDepartments(): the ~30 top-level departments (initial page render)
 *  - loadChildrenAtPath(path): one drill-down level (the /tree route)
 *  - loadLeavesUnderPath(path): all terminal leaves under a path (the /leaves
 *    route — "Add all of X")
 *
 * Each query is verified byte-identical to the buildTree-based childrenAtPath /
 * leavesAtPath against prod data (see the throwaway scripts/checkCb* probes).
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { PATH_SEP } from './buildTree';
import { type LightNode } from './treeNav';

const REVALIDATE = 60 * 60 * 24;
const TAGS = ['category-builder-tree'];

async function getSnapshotMeta(): Promise<{ sv: string | null; wk: string | null }> {
  const sql = neon(env.DATABASE_URL);
  const meta = (await sql`
    SELECT snapshot_version::text AS sv, current_week_end_date::text AS wk
    FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ sv: string | null; wk: string | null }>;
  return { sv: meta[0]?.sv ?? null, wk: meta[0]?.wk ?? null };
}

/** Map raw {name, terminal, has_children} rows to LightNodes, sorted like buildTree. */
function toSortedLevel(
  rows: Array<{ name: string; terminal: boolean; has_children: boolean }>,
): LightNode[] {
  return rows
    .map((r) => ({ name: r.name, hasChildren: r.has_children, terminal: r.terminal }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Root departments (initial page render) ----

const buildCachedRoots = unstable_cache(
  async (_sv: string, wk: string): Promise<LightNode[]> => {
    const sql = neon(env.DATABASE_URL);
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
    return toSortedLevel(rows);
  },
  ['category-builder-roots'],
  { revalidate: REVALIDATE, tags: TAGS },
);

export async function loadRootDepartments(): Promise<LightNode[]> {
  const { sv, wk } = await getSnapshotMeta();
  if (!wk) return [];
  return buildCachedRoots(sv ?? 'no-snapshot', wk);
}

// ---- Children at a path (drill-down) ----

const buildCachedChildren = unstable_cache(
  async (_sv: string, wk: string, prefix: string): Promise<LightNode[]> => {
    const sql = neon(env.DATABASE_URL);
    // Strip the path prefix, then group the next segment — same shape as roots,
    // but scoped to rows under `prefix`. starts_with avoids LIKE wildcard issues.
    const rows = (await sql`
      WITH sub AS (
        SELECT substring(category_path from char_length(${prefix}) + 1) AS rest
        FROM asin_weekly_data
        WHERE week_end_date = ${wk}::date AND starts_with(category_path, ${prefix})
      )
      SELECT
        split_part(rest, ' › ', 1) AS name,
        bool_or(rest = split_part(rest, ' › ', 1)) AS terminal,
        bool_or(position(' › ' in rest) > 0) AS has_children
      FROM sub
      WHERE rest <> ''
      GROUP BY 1
    `) as Array<{ name: string; terminal: boolean; has_children: boolean }>;
    return toSortedLevel(rows);
  },
  ['category-builder-children'],
  { revalidate: REVALIDATE, tags: TAGS },
);

export async function loadChildrenAtPath(path: string[]): Promise<LightNode[]> {
  const { sv, wk } = await getSnapshotMeta();
  if (!wk) return [];
  if (path.length === 0) return buildCachedRoots(sv ?? 'no-snapshot', wk);
  const prefix = path.join(PATH_SEP) + PATH_SEP;
  return buildCachedChildren(sv ?? 'no-snapshot', wk, prefix);
}

// ---- Leaves under a path ("Add all of X") ----

const buildCachedLeaves = unstable_cache(
  async (_sv: string, wk: string, pathStr: string, prefix: string): Promise<string[]> => {
    const sql = neon(env.DATABASE_URL);
    const rows = (await sql`
      SELECT DISTINCT category_path FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND (category_path = ${pathStr} OR starts_with(category_path, ${prefix}))
        AND category_path IS NOT NULL AND category_path <> ''
    `) as Array<{ category_path: string }>;
    return rows
      .map((r) => r.category_path)
      .sort((a, b) => a.localeCompare(b));
  },
  ['category-builder-leaves-v2'],
  { revalidate: REVALIDATE, tags: TAGS },
);

export async function loadLeavesUnderPath(path: string[]): Promise<string[]> {
  const { sv, wk } = await getSnapshotMeta();
  if (!wk) return [];
  const pathStr = path.join(PATH_SEP);
  // Empty path → every leaf in the tree (starts_with(x, '') matches all rows).
  const prefix = path.length === 0 ? '' : pathStr + PATH_SEP;
  return buildCachedLeaves(sv ?? 'no-snapshot', wk, pathStr, prefix);
}
