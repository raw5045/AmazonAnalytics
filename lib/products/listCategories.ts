// lib/products/listCategories.ts
/**
 * The Products page's category option lists (spec 2026-10-12 (category filters) §4.4; spec 2026-10-19 §6),
 * read from product_category_facets — one row per distinct catalog path with its department, rebuilt in one
 * transaction by every weekly import (lib/products/buildCategoryFacets.ts) — and cached an hour with
 * unstable_cache like lib/explorer/listLeafCategories.ts. Nothing here scans the catalog: a cache miss is an
 * index read in milliseconds (the scans this replaced read hundreds of MB per department).
 *  - listProductDepartments: the distinct departments of the facets (36 today);
 *  - listProductCategoryPaths: every facet path (23,429 today), read one department at a time through
 *    product_category_facets_department_idx and cached per department (unstable_cache keys on the function's
 *    arguments). Per department because Next's data cache refuses entries over 2 MB (it warns and skips in
 *    production, throws in dev) and the full list is about 2 MB today; the per-department entries stay well
 *    under it (the largest, Books, is roughly 0.35 MB);
 *  - listProductBroadCategories: the distinct codes of ba_category_crosswalk (spec 2026-10-14 §7; ~24k rows,
 *    milliseconds whatever the plan), read through neonRunner so PRODUCT_READ_TIMEOUT_MS caps it like the
 *    page's reads.
 * All three lists are sorted by plain code-unit comparison so the order never depends on the host's ICU data
 * (lib/research/categories.ts sorts the same way). An empty facets table (before the first build) or crosswalk
 * gives empty lists: the page shows no category options and the tools reject category scopes, which is why the
 * first build precedes the deploy (spec 2026-10-19 §13). A path first seen mid-week joins the lists at the next
 * build; the search predicate runs on the live catalog, so any listed path matches correctly.
 * A failed read rejects the whole list (the tools validate category scopes against it, so a partial list would
 * turn a transient error into a false CATEGORY_NOT_AVAILABLE); never catch inside a cached function, or an
 * empty list is cached for an hour.
 * Each cached callback holds its own statement: Next keys a data-cache entry on the callback's source text plus
 * the key parts, so an edit to the SQL starts a new entry instead of serving the old statement's results
 * (Vercel's data cache outlives a deploy) until the hour is up. The broad-category cache keys on its statement
 * text explicitly: its callback names the exported BROAD_CATEGORY_LIST_SQL (the integration test runs the same
 * text), so the text is a key part.
 */
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { neonRunner } from './searchProducts';

const REVALIDATE_SECONDS = 60 * 60;
/** One tag for the three lists, so a future revalidateTag can refresh them together. */
export const PRODUCT_CATEGORIES_TAG = 'product-categories';

/** `a < b ? -1 : a > b ? 1 : 0`: a pure function of the strings, unlike localeCompare (host ICU data). */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the per-department lists as one deduplicated list in code-unit order. */
export function assemblePathLists(lists: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return [...new Set(lists.flat())].sort(compareCodeUnits);
}

/** The facets' departments, in code-unit order (the statement's ORDER BY is the database's collation; re-sorted here). */
async function fetchDepartmentsSorted(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`SELECT DISTINCT department FROM product_category_facets ORDER BY department`) as Array<{ department: string }>;
  return rows.map((r) => r.department).sort(compareCodeUnits);
}

/**
 * fetchDepartmentsSorted, cached an hour (it is the callback itself, so the key covers its statement; see the header).
 * React's cache dedupes it per render: the page calls it twice at once (directly and via listProductCategoryPaths).
 */
export const listProductDepartments = cache(
  unstable_cache(fetchDepartmentsSorted, ['product-departments'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] }),
);

/** One department's facet paths (the department itself and everything under it), through the department index. */
async function fetchPathsForDepartment(dept: string): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`SELECT category_path FROM product_category_facets WHERE department = ${dept} ORDER BY category_path`) as Array<{ category_path: string }>;
  return rows.map((r) => r.category_path);
}

const cachedPathsForDepartment = unstable_cache(fetchPathsForDepartment, ['product-category-paths'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] });

/** Every facet path, assembled from the per-department caches. */
export async function listProductCategoryPaths(): Promise<string[]> {
  const departments = await listProductDepartments();
  const lists = await Promise.all(departments.map((dept) => cachedPathsForDepartment(dept)));
  return assemblePathLists(lists);
}

/**
 * The Brand Analytics codes the crosswalk maps paths to (spec 2026-10-14 §7): what the Products page's broad
 * filter can match. Empty until the first build. The text is also a key part of the cache below, so an edit
 * to it starts a new entry (the callback does not inline it).
 */
export const BROAD_CATEGORY_LIST_SQL = 'SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code';

/**
 * The codes in code-unit order (the statement's ORDER BY follows the database's collation; re-sorted here).
 * Run through neonRunner, so PRODUCT_READ_TIMEOUT_MS caps the read like every web read (the weekly rebuild
 * deletes and re-inserts under a lock that admits readers, so none waits on it).
 */
async function fetchBroadCategoriesSorted(): Promise<string[]> {
  const run = neonRunner(neon(env.DATABASE_URL));
  const rows = (await run(BROAD_CATEGORY_LIST_SQL, [])) as Array<{ code: string }>;
  return rows.map((r) => r.code).sort(compareCodeUnits);
}

/** fetchBroadCategoriesSorted, cached an hour under its statement text (see BROAD_CATEGORY_LIST_SQL) and deduped per render. */
export const listProductBroadCategories = cache(
  unstable_cache(fetchBroadCategoriesSorted, ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] }),
);
