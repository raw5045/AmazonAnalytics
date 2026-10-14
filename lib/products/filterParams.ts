// lib/products/filterParams.ts
/**
 * The zod-free half of the product-search filters (spec 2026-10-09 §5.1): the ProductFilters shape,
 * its constants and defaults, the URL serialiser, and which sorts hide products without a sort key.
 * No runtime imports at all, so the Products page's client components can import it without
 * pulling zod into the browser bundle. ./filters adds the zod schema and parseProductFilters and
 * re-exports everything here; ./searchProducts re-exports the sort-key symbols. Prices are cents
 * here and dollars in the URL; ratings are stars × 10.
 */

export const PRODUCT_AGES = [60, 90, 180, 365] as const;
export const PRODUCT_SORTS = ['sold', 'listed', 'reviews', 'price', 'bsr', 'ratio', 'keywords'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const PRODUCT_PAGE_SIZE = 50;
export const PRODUCT_MAX_PAGE = 200;
export const MAX_CATEGORY_PATH_LENGTH = 256;
/** Leaf picks a URL may carry (`leaf` repeated), the Explorer's MAX_LEAF_PATHS. */
export const PRODUCT_MAX_LEAF_PATHS = 2000;
/** Custom-category ids a URL may carry (`custom`, comma-separated), the Explorer's MAX_CUSTOM_CATEGORY_IDS. */
export const PRODUCT_MAX_CUSTOM_IDS = 50;
/** The widest `broad` value a URL may carry: ba_category_crosswalk.code is varchar(255), the same bound as the report column top_clicked_category_1 it is learned from. */
export const PRODUCT_MAX_BROAD_CATEGORY_LENGTH = 255;

/** The validated filters. ./filters' productFiltersSchema infers exactly this type (pinned in filters.test.ts). */
export type ProductFilters = {
  age: (typeof PRODUCT_AGES)[number] | null;
  soldMin: number | null;
  reviewsMax: number | null;
  /** Stars × 10 (0–50). */
  ratingMin: number | null;
  ratingMax: number | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  bsrMin: number | null;
  bsrMax: number | null;
  /** rank_ratio_x100 ≤ N (e.g. 70 = at least 30 % better than the 30-day average). */
  ratioMax: number | null;
  /** One Keepa root department ('Health & Household'): the product's own storefront department, matched at any depth (spec 2026-10-12 §3). */
  dept: string | null;
  /** One Brand Analytics code ('Home', 'Pet Supplies'): the product's own Brand Analytics category, the code its Keepa category path maps to in ba_category_crosswalk (one per product; spec 2026-10-14 §6). */
  broadCategory: string | null;
  /** Leaf picks: each matches the path and everything under it; several combine with OR. */
  leafPaths: string[];
  /** The user's custom categories, by id; the page expands them to their stored paths, matched exactly. Unowned ids match nothing. */
  customCategoryIds: string[];
  fba: 'yes' | 'no' | null;
  amazon: 'yes' | 'no' | null;
  sort: ProductSort;
  dir: 'asc' | 'desc';
  page: number;
};

export const PRODUCT_DEFAULTS: Readonly<ProductFilters> = Object.freeze({
  age: null, soldMin: null, reviewsMax: null, ratingMin: null, ratingMax: null, priceMinCents: null, priceMaxCents: null,
  bsrMin: null, bsrMax: null, ratioMax: null, dept: null, broadCategory: null, leafPaths: [], customCategoryIds: [], fba: null, amazon: null, sort: 'sold', dir: 'desc', page: 1,
});

/** The URL form (dollars for prices; defaults omitted) — the inverse of parseProductFilters. */
export function productFiltersToSearchParams(f: ProductFilters): URLSearchParams {
  const sp = new URLSearchParams();
  const set = (k: string, v: unknown, def: unknown) => { if (v !== null && v !== def) sp.set(k, String(v)); };
  set('age', f.age, null); set('soldMin', f.soldMin, null); set('reviewsMax', f.reviewsMax, null); set('ratingMin', f.ratingMin, null); set('ratingMax', f.ratingMax, null);
  if (f.priceMinCents !== null) sp.set('priceMin', (f.priceMinCents / 100).toFixed(2).replace(/\.00$/, ''));
  if (f.priceMaxCents !== null) sp.set('priceMax', (f.priceMaxCents / 100).toFixed(2).replace(/\.00$/, ''));
  set('bsrMin', f.bsrMin, null); set('bsrMax', f.bsrMax, null); set('ratioMax', f.ratioMax, null); set('dept', f.dept, null); set('broad', f.broadCategory, null);
  for (const path of f.leafPaths) sp.append('leaf', path);
  if (f.customCategoryIds.length > 0) sp.set('custom', f.customCategoryIds.join(','));
  set('fba', f.fba, null); set('amazon', f.amazon, null);
  set('sort', f.sort, PRODUCT_DEFAULTS.sort); set('dir', f.dir, PRODUCT_DEFAULTS.dir); set('page', f.page, 1);
  return sp;
}

/** Every sort but `keywords` orders by a nullable catalog column. */
export type NullableKeySort = Exclude<ProductSort, 'keywords'>;
/** The field each hiding sort orders by, for the page's "Products without a <field> are hidden under this sort." hint. */
export const SORT_KEY_LABEL: Readonly<Record<NullableKeySort, string>> = {
  sold: 'monthly sold badge', listed: 'listing date', reviews: 'review count', price: 'price', bsr: 'BSR', ratio: 'BSR ratio',
};
/** True when the sort drops rows whose sort key is NULL: every sort but `keywords` (a count is never NULL). */
export function sortHidesNullKey(sort: ProductSort): sort is NullableKeySort {
  return sort !== 'keywords';
}
