// lib/products/listCategories.ts
/**
 * The Products page's category option lists (spec 2026-10-12 §4.4), cached an hour with
 * unstable_cache like lib/explorer/listLeafCategories.ts:
 *  - listProductDepartments: the distinct Keepa root departments of the rows the page can show
 *    (36 today; the uncached statement scans the catalog, 1.3 s cold, hence the cache);
 *  - listProductCategoryPaths: every distinct category_path of those rows (22,693 today), read one
 *    department at a time through asin_products_category_path_idx and cached per department
 *    (unstable_cache keys on the function's arguments). Per department because Next's data cache
 *    refuses entries over 2 MB (it warns and skips in production, throws in dev) and the full list
 *    is about 1.9 MB today, so one entry would sit at the limit; the per-department entries stay
 *    well under it (the largest, Clothing, is roughly 0.5-1 MB).
 * Both lists are sorted by plain code-unit comparison so the order never depends on the host's
 * ICU data (lib/research/categories.ts sorts the same way). An empty catalog gives empty lists.
 * A failed read rejects the whole list (the tools validate category scopes against it, so a
 * partial list would turn a transient error into a false CATEGORY_NOT_AVAILABLE); never catch
 * inside a cached function, or an empty list is cached for an hour.
 */
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';

const REVALIDATE_SECONDS = 60 * 60;
/** One tag for both lists, so a future revalidateTag can refresh them together. */
export const PRODUCT_CATEGORIES_TAG = 'product-categories';

/** `a < b ? -1 : a > b ? 1 : 0`: a pure function of the strings, unlike localeCompare (host ICU data). */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the per-department lists as one deduplicated list in code-unit order. */
export function assemblePathLists(lists: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return [...new Set(lists.flat())].sort(compareCodeUnits);
}

async function fetchDepartments(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT category_root FROM asin_products
    WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_root IS NOT NULL
    ORDER BY category_root
  `) as Array<{ category_root: string }>;
  return rows.map((r) => r.category_root);
}

/**
 * The catalog's root departments, in code-unit order (the statement's ORDER BY is the database's collation; re-sorted here).
 * React's cache dedupes it per render: the page calls it twice at once (directly and via listProductCategoryPaths), and a full miss would scan twice.
 */
export const listProductDepartments = cache(
  unstable_cache(
    async () => [...(await fetchDepartments())].sort(compareCodeUnits),
    ['product-departments'],
    { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] },
  ),
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
