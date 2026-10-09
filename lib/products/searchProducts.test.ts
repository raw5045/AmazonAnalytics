// lib/products/searchProducts.test.ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { asinProducts, keywordTopAsins } from '@/db/schema';
import { PRODUCT_DEFAULTS, PRODUCT_SORTS, type ProductFilters } from './filters';
import { productSearchSql, searchProducts, neonRunner, sortHidesNullKey, SORT_KEY_LABEL, PRODUCT_COUNT_CAP } from './searchProducts';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));
const aliasCols = (text: string, alias: string) => new Set([...text.matchAll(new RegExp(`\\b${alias}\\.([a-z0-9_]+)`, 'g'))].map((m) => m[1]));
/** The capped-count statement (the rows statement also contains `count(*)`, in its keyword-count lateral). */
const isCountStatement = (text: string) => text.startsWith('SELECT count(*)');
/** Every sort but `keywords`, with the catalog column it orders by (and hides the nulls of). */
const NULL_KEY_SORTS: Array<[sort: ProductFilters['sort'], column: string]> = [
  ['sold', 'monthly_sold'], ['listed', 'listed_since'], ['reviews', 'review_count'], ['price', 'current_price_cents'], ['bsr', 'sales_rank'], ['ratio', 'rank_ratio_x100'],
];

describe('productSearchSql', () => {
  it('applies the base predicate, hides null sort keys, and pages before counting keywords', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS);
    const t = q.rows.text;
    expect(t).toContain("a.in_scope AND a.enrichment_status IN ('active', 'no_price')");
    expect(t).toContain('a.monthly_sold IS NOT NULL');
    // The filter, the order and the page are the subquery; only its 50 rows get the keyword count.
    expect(t.startsWith('SELECT p.*, COALESCE(kc.keyword_count, 0) AS keyword_count FROM (SELECT a.asin, ')).toBe(true);
    expect(t).toContain('ORDER BY a.monthly_sold DESC, a.asin LIMIT $1 OFFSET $2) p LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = p.asin) kc ON true ORDER BY p.monthly_sold DESC, p.asin');
    expect(t).not.toContain('NULLS');
    expect(q.rows.values).toEqual([50, 0]);
    // The count carries the same WHERE (so the total is what the pager can reach) and stops at the cap.
    expect(q.count.text).toBe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL LIMIT ${PRODUCT_COUNT_CAP}) c`);
    expect(q.count.values).toEqual([]);
  });
  it('maps every filter to its predicate with bound values', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, cat: 'Tools › Bath', fba: 'no', amazon: 'yes', sort: 'listed', dir: 'asc', page: 3 });
    const t = q.rows.text;
    expect(t).toContain('a.listed_since >= current_date - $1::int');
    expect(t).toContain('a.monthly_sold >= $2::int');
    expect(t).toContain('a.review_count <= $3::int');
    expect(t).toContain('a.average_rating_x10 >= $4::int');
    expect(t).toContain('a.average_rating_x10 <= $5::int');
    expect(t).toContain('a.current_price_cents >= $6::int');
    expect(t).toContain('a.current_price_cents <= $7::int');
    expect(t).toContain('a.sales_rank >= $8::int');
    expect(t).toContain('a.sales_rank <= $9::int');
    expect(t).toContain('a.rank_ratio_x100 <= $10::int');
    expect(t).toContain("(a.category_path = $11::text OR starts_with(a.category_path, $12::text))");
    expect(t).toContain('a.fba_offer_count = 0');
    expect(t).toContain('a.amazon_availability >= 0');
    expect(t).toContain('a.listed_since IS NOT NULL');
    expect(t).toContain('ORDER BY a.listed_since ASC, a.asin LIMIT $13 OFFSET $14) p');
    expect(t.endsWith(' ORDER BY p.listed_since ASC, p.asin')).toBe(true);
    expect(q.rows.values).toEqual([90, 1000, 300, 40, 50, 999, 4000, 1, 50000, 70, 'Tools › Bath', 'Tools › Bath › ', 50, 100]);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
    expect(q.count.text).toContain('a.listed_since IS NOT NULL');
  });
  it('fba=yes and amazon=no', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, fba: 'yes', amazon: 'no' }).rows.text;
    expect(t).toContain('a.fba_offer_count > 0');
    expect(t).toContain('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  });
  it.each(NULL_KEY_SORTS)('%s sort hides null keys, orders the page, then re-orders its 50 rows', (sort, column) => {
    for (const dir of ['asc', 'desc'] as const) {
      const D = dir.toUpperCase();
      const q = productSearchSql({ ...PRODUCT_DEFAULTS, sort, dir });
      expect(q.rows.text).toContain(`a.${column} IS NOT NULL`);
      expect(q.rows.text).toContain(`ORDER BY a.${column} ${D}, a.asin LIMIT $1 OFFSET $2) p `);
      expect(q.rows.text.endsWith(` ORDER BY p.${column} ${D}, p.asin`)).toBe(true);
      expect(q.rows.text).not.toContain('NULLS');
      expect(q.count.text).toContain(`a.${column} IS NOT NULL`);
    }
  });
  it('sorts by the keyword count single-level, through the lateral count', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords' });
    const t = q.rows.text;
    expect(t).toContain('LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = a.asin) kc ON true');
    expect(t).toContain('ORDER BY kc.keyword_count DESC NULLS LAST, a.asin LIMIT $1 OFFSET $2');
    expect(t.startsWith('SELECT a.asin, ')).toBe(true);
    expect(t).toContain('kc.keyword_count FROM asin_products a LEFT JOIN LATERAL');
    expect(t).not.toContain(') p ');
    // A count is never null, so there is nothing to hide.
    expect(t).not.toContain('IS NOT NULL');
    expect(q.count.text).not.toContain('IS NOT NULL');
  });
  it.each(PRODUCT_SORTS)('%s: names only real columns', (sort) => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, sort, age: 60, cat: 'x', fba: 'yes', amazon: 'yes', ratioMax: 50 }).rows.text;
    const a = aliasCols(t, 'a');
    expect([...a].filter((c) => !dbCols(asinProducts).has(c))).toEqual([]);
    expect([...aliasCols(t, 'k')].filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
    // `p` is the page subquery: every column the outer query reads from it is one the subquery selects from `a`.
    expect([...aliasCols(t, 'p')].filter((c) => !a.has(c))).toEqual([]);
  });
});

describe('sortHidesNullKey', () => {
  it('is true for every sort but keywords', () => {
    expect(Object.fromEntries(PRODUCT_SORTS.map((s) => [s, sortHidesNullKey(s)]))).toEqual({ sold: true, listed: true, reviews: true, price: true, bsr: true, ratio: true, keywords: false });
  });
  it('is paired with a human field name for each sort that hides rows', () => {
    expect(SORT_KEY_LABEL).toEqual({ sold: 'monthly sold', listed: 'listing date', reviews: 'review count', price: 'price', bsr: 'BSR', ratio: 'BSR ratio' });
    expect(Object.keys(SORT_KEY_LABEL).sort()).toEqual(PRODUCT_SORTS.filter(sortHidesNullKey).sort());
  });
  it('narrows the sort so the page can look the label up', () => {
    const hint = (sort: ProductFilters['sort']) => (sortHidesNullKey(sort) ? `Products without a ${SORT_KEY_LABEL[sort]} are hidden under this sort.` : null);
    expect(hint('bsr')).toBe('Products without a BSR are hidden under this sort.');
    expect(hint('keywords')).toBeNull();
  });
});

describe('searchProducts', () => {
  it('runs both statements and maps rows', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fake = async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return isCountStatement(text)
        ? [{ n: 3 }]
        : [{ asin: 'B000000001', title: 'Lamp', brand: 'Acme', listed_since: '2026-08-01', monthly_sold: 1000, review_count: 120, average_rating_x10: 44, current_price_cents: 1999, sales_rank: 1234, rank_ratio_x100: 65, fba_offer_count: 3, fbm_offer_count: 1, amazon_availability: -1, enrichment_status: 'active', keyword_count: 7 }];
    };
    const r = await searchProducts(fake, PRODUCT_DEFAULTS);
    expect(r.total).toBe(3);
    expect(r.totalIsCapped).toBe(false);
    expect(r.rows[0]).toMatchObject({ asin: 'B000000001', monthlySold: 1000, rankRatioX100: 65, keywordCount: 7, amazonAvailability: -1 });
    expect(calls).toHaveLength(2);
  });
  it('flags a capped total and defaults a missing keyword count to 0', async () => {
    const fake = async (text: string) => (isCountStatement(text) ? [{ n: PRODUCT_COUNT_CAP }] : [{ asin: 'B000000002', keyword_count: null }]);
    const r = await searchProducts(fake, { ...PRODUCT_DEFAULTS, page: 2 });
    expect(r.total).toBe(PRODUCT_COUNT_CAP);
    expect(r.totalIsCapped).toBe(true);
    expect(r.rows[0].keywordCount).toBe(0);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(50);
  });
});

describe('neonRunner', () => {
  it('passes the text and positional values to sql.query and returns the rows', async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const run = neonRunner({ query: async (text, values) => { calls.push([text, values]); return [{ n: 1 }]; } });
    await expect(run('SELECT $1::int AS n', [1])).resolves.toEqual([{ n: 1 }]);
    expect(calls).toEqual([['SELECT $1::int AS n', [1]]]);
  });
  it('accepts the real neon client (@neondatabase/serverless 1.x exposes sql.query(text, params))', () => {
    expectTypeOf<NeonQueryFunction<false, false>>().toExtend<Parameters<typeof neonRunner>[0]>();
  });
});
