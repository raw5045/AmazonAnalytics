// lib/products/searchProducts.test.ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { asinProducts, keywordTopAsins } from '@/db/schema';
import { PRODUCT_DEFAULTS } from './filters';
import { productSearchSql, searchProducts, neonRunner, PRODUCT_COUNT_CAP } from './searchProducts';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));
const aliasCols = (text: string, alias: string) => new Set([...text.matchAll(new RegExp(`\\b${alias}\\.([a-z0-9_]+)`, 'g'))].map((m) => m[1]));
/** The capped-count statement (the rows statement also contains `count(*)`, in its keyword-count lateral). */
const isCountStatement = (text: string) => text.startsWith('SELECT count(*)');

describe('productSearchSql', () => {
  it('always applies the base predicate and the page', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS);
    expect(q.rows.text).toContain("a.in_scope AND a.enrichment_status IN ('active', 'no_price')");
    expect(q.rows.text).toContain('ORDER BY a.monthly_sold DESC NULLS LAST, a.asin');
    expect(q.rows.values.slice(-2)).toEqual([50, 0]);
    expect(q.count.text).toContain('count(*)');
    expect(q.count.text).toContain(`LIMIT ${PRODUCT_COUNT_CAP}`);
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
    expect(t).toContain('ORDER BY a.listed_since ASC NULLS LAST, a.asin');
    expect(q.rows.values).toEqual([90, 1000, 300, 40, 50, 999, 4000, 1, 50000, 70, 'Tools › Bath', 'Tools › Bath › ', 50, 100]);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
  });
  it('fba=yes and amazon=no', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, fba: 'yes', amazon: 'no' }).rows.text;
    expect(t).toContain('a.fba_offer_count > 0');
    expect(t).toContain('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  });
  it('sorts by the keyword count through the lateral count', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords' }).rows.text;
    expect(t).toContain('LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = a.asin) kc ON true');
    expect(t).toContain('ORDER BY kc.keyword_count DESC NULLS LAST, a.asin');
  });
  it('names only real columns', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 60, cat: 'x', fba: 'yes', amazon: 'yes', ratioMax: 50 });
    expect([...aliasCols(q.rows.text, 'a')].filter((c) => !dbCols(asinProducts).has(c))).toEqual([]);
    expect([...aliasCols(q.rows.text, 'k')].filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
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
