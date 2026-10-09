// lib/products/filters.ts
/**
 * Product-search filters (spec 2026-10-09 §5.1): the validated shape behind the Products page URL.
 * parseProductFilters never throws — a value that fails its schema branch falls back to that
 * field's default, like the explorer. Prices are cents here and dollars in the URL.
 * lib/research/contracts.ts does NOT re-export this schema: the search_products tool defines its own
 * dollar-based productSearchInputSchema (Task 13), whose mapper converts it onto ProductFilters.
 *
 * The zod-free half (the ProductFilters type, the constants and defaults, the URL serialiser) lives
 * in ./filterParams, which client components import so zod stays out of the browser bundle. It is
 * re-exported here, so every import from this module keeps working.
 */
import { z } from 'zod';
import { MAX_CATEGORY_PATH_LENGTH, PRODUCT_AGES, PRODUCT_DEFAULTS, PRODUCT_MAX_PAGE, PRODUCT_SORTS, type ProductFilters } from './filterParams';

export * from './filterParams';

const INT4_MAX = 2_147_483_647;

export const productFiltersSchema = z.strictObject({
  age: z.literal(PRODUCT_AGES).nullable(),
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
  cat: z.string().trim().min(1).max(MAX_CATEGORY_PATH_LENGTH).nullable(),
  fba: z.enum(['yes', 'no']).nullable(),
  amazon: z.enum(['yes', 'no']).nullable(),
  sort: z.enum(PRODUCT_SORTS),
  dir: z.enum(['asc', 'desc']),
  page: z.int().min(1).max(PRODUCT_MAX_PAGE),
});

export type SearchParamsLike = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
/** Unsigned integer text (no sign, no decimals), else null; the schema's own bounds do the rest. */
const int = (v: string | undefined): number | null => (v !== undefined && /^\d{1,10}$/.test(v) ? Number(v) : null);
/** "9.99" → 999 cents; integers allowed; 8 integer digits so a price at the schema ceiling re-parses; anything else null. */
const dollarsToCents = (v: string | undefined): number | null => (v !== undefined && /^\d{1,8}(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null);
/** Any all-digit page clamps to the last page (a huge ?page= lands there, not on page 1); 0 and non-digits fall to the default. */
const pageNumber = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Math.min(Number(v), PRODUCT_MAX_PAGE) : null);

/** Field-by-field: each value that fails its schema branch falls back to the default for that field. */
export function parseProductFilters(sp: SearchParamsLike): ProductFilters {
  const raw: Record<keyof ProductFilters, unknown> = {
    age: int(one(sp.age)), soldMin: int(one(sp.soldMin)), reviewsMax: int(one(sp.reviewsMax)), ratingMin: int(one(sp.ratingMin)), ratingMax: int(one(sp.ratingMax)),
    priceMinCents: dollarsToCents(one(sp.priceMin)), priceMaxCents: dollarsToCents(one(sp.priceMax)), bsrMin: int(one(sp.bsrMin)), bsrMax: int(one(sp.bsrMax)),
    ratioMax: int(one(sp.ratioMax)), cat: one(sp.cat) ?? null, fba: one(sp.fba) ?? null, amazon: one(sp.amazon) ?? null,
    sort: one(sp.sort) ?? PRODUCT_DEFAULTS.sort, dir: one(sp.dir) ?? PRODUCT_DEFAULTS.dir, page: pageNumber(one(sp.page)),
  };
  const out = { ...PRODUCT_DEFAULTS } as Record<keyof ProductFilters, unknown>;
  for (const key of Object.keys(productFiltersSchema.shape) as (keyof ProductFilters)[]) {
    const r = productFiltersSchema.shape[key].safeParse(raw[key]);
    if (r.success) out[key] = r.data;
  }
  return out as ProductFilters;
}
