// lib/explorer/enrichedProductsQuery.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTableColumns, type Table } from 'drizzle-orm';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
import { asinProducts, asinWeeklyData } from '@/db/schema';
import { enrichedProductsFor, mapEnrichedProducts, type EnrichedProduct } from './fetchKeywordDetail';

/** A tagged-template stand-in for neon's sql: returns the joined text and the bound values. */
const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve({ text: strings.join('?'), values })) as never;
type Captured = { text: string; values: unknown[] };

/** Every `a.<column>` a statement references. */
const aliasColumns = (text: string) => new Set([...text.matchAll(/\ba\.([a-z0-9_]+)/g)].map((m) => m[1]));
/** A statement's SELECT list (between its first SELECT and FROM). */
const selectList = (text: string) => text.slice(text.indexOf('SELECT'), text.indexOf('FROM'));
/** A table's database column names, per the drizzle schema. */
const dbColumns = (table: Table) => new Set(Object.values(getTableColumns(table)).map((c) => c.name));
const missingFrom = (cols: Set<string>, from: Set<string>) => [...cols].filter((c) => !from.has(c));

/** The statement enrichedProductsFor builds under a KEEPA_READ_SOURCE value ('' = unset). */
async function statementFor(source: '' | 'products'): Promise<Captured> {
  vi.stubEnv('KEEPA_READ_SOURCE', source);
  return (await enrichedProductsFor(fakeSql, '42')) as unknown as Captured;
}

describe('enrichedProductsFor', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the per-week table at the keyword\'s current week by default', async () => {
    const q = await statementFor('');
    expect(q.text).toContain('FROM asin_weekly_data a');
    expect(q.text).toContain('a.week_end_date = kcs.current_week_end_date');
    expect(q.values).toEqual(['42']);
  });

  it('reads the catalog with the new fields when KEEPA_READ_SOURCE=products', async () => {
    const q = await statementFor('products');
    expect(q.text).toContain('FROM asin_products a');
    expect(q.text).not.toContain('a.week_end_date');
    expect(q.text).toContain('a.monthly_sold');
    expect(q.text).toContain('a.fba_offer_count');
    expect(q.text).toContain('a.enrichment_status IS NOT NULL');
    expect(q.values).toEqual(['42']);
  });

  it('names only real columns, and the catalog selects every column the weekly variant does', async () => {
    const weekly = await statementFor('');
    const catalog = await statementFor('products');
    expect(aliasColumns(weekly.text).size).toBeGreaterThan(10);
    expect(missingFrom(aliasColumns(weekly.text), dbColumns(asinWeeklyData))).toEqual([]);
    expect(missingFrom(aliasColumns(catalog.text), dbColumns(asinProducts))).toEqual([]);
    expect(missingFrom(aliasColumns(selectList(weekly.text)), aliasColumns(selectList(catalog.text)))).toEqual([]);
  });
});

describe('mapEnrichedProducts', () => {
  const row = (status: string, extra: Record<string, unknown> = {}) => ({
    asin: 'B0A',
    title: 'Oil',
    brand: 'Acme',
    image_url: null,
    category_path: 'Health › Oils',
    category_root: 'Health',
    category_leaf: 'Oils',
    current_price_cents: 1999,
    sales_rank: 500,
    review_count: 4321,
    average_rating_x10: 45,
    avg30_price_cents: 2001,
    avg90_price_cents: 2002,
    avg180_price_cents: 2003,
    avg365_price_cents: 2004,
    enrichment_status: status,
    ...extra,
  });
  const prices = (p: EnrichedProduct) => [p.currentPriceCents, p.avg30PriceCents, p.avg90PriceCents, p.avg180PriceCents, p.avg365PriceCents];

  it('keeps every price of an active row', () => {
    expect(prices(mapEnrichedProducts([row('active')]).B0A)).toEqual([1999, 2001, 2002, 2003, 2004]);
  });

  it.each(['no_price', 'delisted', 'error'])('drops every price of a %s row but keeps reviews, rating, rank and category', (status) => {
    const p = mapEnrichedProducts([row(status)]).B0A;
    expect(prices(p)).toEqual([null, null, null, null, null]);
    expect(p).toMatchObject({
      title: 'Oil',
      reviewCount: 4321,
      averageRatingX10: 45,
      salesRank: 500,
      categoryPath: 'Health › Oils',
      categoryLeaf: 'Oils',
      enrichmentStatus: status,
    });
  });

  it('maps the catalog-only fields, null when a weekly row lacks them', () => {
    const weekly = mapEnrichedProducts([row('active')]).B0A;
    expect([weekly.monthlySold, weekly.keepaUpdatedAt, weekly.fbaOfferCount, weekly.avg90SalesRank]).toEqual([null, null, null, null]);
    const catalog = mapEnrichedProducts([
      row('active', {
        monthly_sold: 1000,
        keepa_updated_at: '2026-10-04',
        listed_since: '2018-03-19',
        new_offer_count: 7,
        fba_offer_count: 5,
        fbm_offer_count: 2,
        amazon_availability: 0,
        avg30_sales_rank: 480,
        avg90_sales_rank: 510,
      }),
    ]).B0A;
    expect(catalog).toMatchObject({
      monthlySold: 1000,
      keepaUpdatedAt: '2026-10-04',
      listedSince: '2018-03-19',
      newOfferCount: 7,
      fbaOfferCount: 5,
      fbmOfferCount: 2,
      amazonAvailability: 0,
      avg30SalesRank: 480,
      avg90SalesRank: 510,
    });
  });
});
