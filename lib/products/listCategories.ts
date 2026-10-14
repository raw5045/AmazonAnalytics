// lib/products/listCategories.ts
/**
 * The Products page's category option lists (spec 2026-10-12 (category filters) §4.4), cached an hour with
 * unstable_cache like lib/explorer/listLeafCategories.ts:
 *  - listProductDepartments: the distinct Keepa root departments of the rows the page can show
 *    (36 today; the uncached statement scans the catalog, 1.3 s cold, hence the cache);
 *  - listProductCategoryPaths: every distinct category_path of those rows (22,693 today), read one
 *    department at a time through asin_products_category_path_idx and cached per department
 *    (unstable_cache keys on the function's arguments). Per department because Next's data cache
 *    refuses entries over 2 MB (it warns and skips in production, throws in dev) and the full list
 *    is about 1.9 MB today, so one entry would sit at the limit; the per-department entries stay
 *    well under it (the largest, Clothing, is roughly 0.5-1 MB);
 *  - listProductBroadCategories: the distinct codes of ba_category_crosswalk (spec 2026-10-14 §7; ~24k
 *    rows, milliseconds whatever the plan), read through neonRunner so PRODUCT_READ_TIMEOUT_MS caps it
 *    like the page's reads.
 * All three lists are sorted by plain code-unit comparison so the order never depends on the host's
 * ICU data (lib/research/categories.ts sorts the same way). An empty catalog (or crosswalk) gives empty lists.
 * A failed read rejects the whole list (the tools validate category scopes against it, so a
 * partial list would turn a transient error into a false CATEGORY_NOT_AVAILABLE); never catch
 * inside a cached function, or an empty list is cached for an hour.
 * Each cached callback holds its own statement: Next keys a data-cache entry on the callback's
 * source text plus the key parts, so an edit to the SQL starts a new entry instead of serving the
 * old statement's results (Vercel's data cache outlives a deploy) until the hour is up. The
 * broad-category cache keys on its statement text explicitly: its callback names the exported
 * BROAD_CATEGORY_LIST_SQL (the integration test runs the same text), so the text is a key part.
 */
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
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

/** The catalog's root departments, in code-unit order (the statement's ORDER BY is the database's collation; re-sorted here). */
async function fetchDepartmentsSorted(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT category_root FROM asin_products
    WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_root IS NOT NULL
    ORDER BY category_root
  `) as Array<{ category_root: string }>;
  return rows.map((r) => r.category_root).sort(compareCodeUnits);
}

/**
 * fetchDepartmentsSorted, cached an hour (it is the callback itself, so the key covers its statement; see the header).
 * React's cache dedupes it per render: the page calls it twice at once (directly and via listProductCategoryPaths), and a full miss would scan twice.
 */
export const listProductDepartments = cache(
  unstable_cache(fetchDepartmentsSorted, ['product-departments'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] }),
);

/** One department's distinct paths: the root itself and everything under it, through the path index. */
async function fetchPathsForDepartment(dept: string): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT category_path FROM asin_products
    WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active', 'no_price')
      AND (category_path = ${dept} OR starts_with(category_path, ${dept + PATH_SEP}))
    ORDER BY category_path
  `) as Array<{ category_path: string }>;
  return rows.map((r) => r.category_path);
}

const cachedPathsForDepartment = unstable_cache(fetchPathsForDepartment, ['product-category-paths'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] });

/** Every distinct category path of the rows the page can show, assembled from the per-department caches. */
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
