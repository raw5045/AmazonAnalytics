// lib/products/filters.ts
/**
 * Product-search filters (spec 2026-10-09 §5.1): one zod schema shared by the Products page URL
 * (parseProductFilters never throws — a bad value falls back to its default, like the explorer)
 * and the search_products tool contract (lib/research/contracts.ts re-exports it).
 */
import { z } from 'zod';

export const PRODUCT_AGES = [60, 90, 180, 365] as const;
export const PRODUCT_SORTS = ['sold', 'listed', 'reviews', 'price', 'bsr', 'ratio', 'keywords'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const PRODUCT_PAGE_SIZE = 50;
export const PRODUCT_MAX_PAGE = 200;
export const MAX_CATEGORY_PATH_LENGTH = 256;
const INT4_MAX = 2_147_483_647;

export const productFiltersSchema = z.strictObject({
  age: z.union([z.literal(60), z.literal(90), z.literal(180), z.literal(365)]).nullable(),
  soldMin: z.int().min(1).max(INT4_MAX).nullable(),
  reviewsMax: z.int().min(0).max(INT4_MAX).nullable(),
  ratingMin: z.int().min(0).max(50).nullable(),
  ratingMax: z.int().min(0).max(50).nullable(),
  priceMinCents: z.int().min(0).max(INT4_MAX).nullable(),
  priceMaxCents: z.int().min(0).max(INT4_MAX).nullable(),
  bsrMin: z.int().min(1).max(INT4_MAX).nullable(),
  bsrMax: z.int().min(1).max(INT4_MAX).nullable(),
  /** rank_ratio_x100 ≤ N (e.g. 70 = at least 30 % better than the 30-day average). */
  ratioMax: z.int().min(1).max(1000).nullable(),
  cat: z.string().min(1).max(MAX_CATEGORY_PATH_LENGTH).nullable(),
  fba: z.enum(['yes', 'no']).nullable(),
  amazon: z.enum(['yes', 'no']).nullable(),
  sort: z.enum(PRODUCT_SORTS),
  dir: z.enum(['asc', 'desc']),
  page: z.int().min(1).max(PRODUCT_MAX_PAGE),
});
export type ProductFilters = z.infer<typeof productFiltersSchema>;

export const PRODUCT_DEFAULTS: ProductFilters = Object.freeze({
  age: null, soldMin: null, reviewsMax: null, ratingMin: null, ratingMax: null, priceMinCents: null, priceMaxCents: null,
  bsrMin: null, bsrMax: null, ratioMax: null, cat: null, fba: null, amazon: null, sort: 'sold', dir: 'desc', page: 1,
}) as ProductFilters;

export type SearchParamsLike = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const int = (v: string | undefined): number | null => (v !== undefined && /^-?\d{1,10}$/.test(v) ? Number(v) : null);
/** "9.99" → 999 cents; integers allowed; anything else null. */
const dollarsToCents = (v: string | undefined): number | null => (v !== undefined && /^\d{1,7}(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null);

/** Field-by-field: each value that fails its schema branch falls back to the default for that field. */
export function parseProductFilters(sp: SearchParamsLike): ProductFilters {
  const raw: Record<keyof ProductFilters, unknown> = {
    age: int(one(sp.age)), soldMin: int(one(sp.soldMin)), reviewsMax: int(one(sp.reviewsMax)), ratingMin: int(one(sp.ratingMin)), ratingMax: int(one(sp.ratingMax)),
    priceMinCents: dollarsToCents(one(sp.priceMin)), priceMaxCents: dollarsToCents(one(sp.priceMax)), bsrMin: int(one(sp.bsrMin)), bsrMax: int(one(sp.bsrMax)),
    ratioMax: int(one(sp.ratioMax)), cat: one(sp.cat) ?? null, fba: one(sp.fba) ?? null, amazon: one(sp.amazon) ?? null,
    sort: one(sp.sort) ?? PRODUCT_DEFAULTS.sort, dir: one(sp.dir) ?? PRODUCT_DEFAULTS.dir, page: Math.min(int(one(sp.page)) ?? 1, PRODUCT_MAX_PAGE),
  };
  const out = { ...PRODUCT_DEFAULTS } as Record<keyof ProductFilters, unknown>;
  for (const key of Object.keys(productFiltersSchema.shape) as (keyof ProductFilters)[]) {
    const r = productFiltersSchema.shape[key].safeParse(raw[key]);
    if (r.success) out[key] = r.data;
  }
  return out as ProductFilters;
}

/** The URL form (dollars for prices; defaults omitted) — the inverse of parseProductFilters. */
export function productFiltersToSearchParams(f: ProductFilters): URLSearchParams {
  const sp = new URLSearchParams();
  const set = (k: string, v: unknown, def: unknown) => { if (v !== null && v !== def) sp.set(k, String(v)); };
  set('age', f.age, null); set('soldMin', f.soldMin, null); set('reviewsMax', f.reviewsMax, null); set('ratingMin', f.ratingMin, null); set('ratingMax', f.ratingMax, null);
  if (f.priceMinCents !== null) sp.set('priceMin', (f.priceMinCents / 100).toFixed(2).replace(/\.00$/, ''));
  if (f.priceMaxCents !== null) sp.set('priceMax', (f.priceMaxCents / 100).toFixed(2).replace(/\.00$/, ''));
  set('bsrMin', f.bsrMin, null); set('bsrMax', f.bsrMax, null); set('ratioMax', f.ratioMax, null); set('cat', f.cat, null); set('fba', f.fba, null); set('amazon', f.amazon, null);
  set('sort', f.sort, PRODUCT_DEFAULTS.sort); set('dir', f.dir, PRODUCT_DEFAULTS.dir); set('page', f.page, 1);
  return sp;
}
