// lib/research/products.test.ts
import { describe, it, expect, vi } from 'vitest';

// products.ts reads env only inside the default loaders (never at import). Both env and neon() are
// mocked, so no test here can reach a database: the fake neon client answers every query with [].
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const neonMock = vi.hoisted(() => {
  const query = vi.fn<(text: string, values?: unknown[]) => Promise<unknown[]>>(async () => []);
  return { query, neon: vi.fn(() => ({ query })) };
});
vi.mock('@neondatabase/serverless', () => ({ neon: neonMock.neon }));

import { PRODUCT_DEFAULTS, PRODUCT_PAGE_SIZE } from '@/lib/products/filters';
import type { ProductFacts as CatalogProductFacts } from '@/lib/products/loadProduct';
import type { HistoryPoint } from '@/lib/products/loadProductHistory';
import type { ProductKeywordRow } from '@/lib/products/loadProductKeywords';
import { PRODUCT_COUNT_CAP, type ProductSummaryRow } from '@/lib/products/searchProducts';
import { ResearchError } from './errors';
import {
  defaultProductsDeps, PRODUCT_TOOL_KEYWORDS_CAP, productDetailsForTool, productUrlFor, searchProductsForTool, type ProductsDeps,
} from './products';
import type { ResearchActor } from './service';

const APP = 'https://keywordquarry.com';
const ASIN = 'B0ABCDEF12';
const admin: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp', isAdmin: true };
const member: ResearchActor = { ...admin, isAdmin: false };
const FORBIDDEN_INFO = { code: 'FORBIDDEN', message: 'Products tools are admin-only for now.', retryable: false };

const summaryRow = (asin: string, over: Partial<ProductSummaryRow> = {}): ProductSummaryRow => ({
  asin, title: `Product ${asin}`, brand: 'Acme', listedSince: '2026-06-01', monthlySold: 1000, reviewCount: 120, averageRatingX10: 46,
  currentPriceCents: 1999, salesRank: 4321, rankRatioX100: 70, fbaOfferCount: 3, fbmOfferCount: 1, amazonAvailability: -1,
  enrichmentStatus: 'active', keywordCount: 4, ...over,
});
const pageRows = [summaryRow('B0AAAAAAA1'), summaryRow('B0AAAAAAA2', { enrichmentStatus: 'no_price', currentPriceCents: null })];

const catalogFacts: CatalogProductFacts = {
  asin: ASIN, title: 'Magnesium glycinate 400 mg', brand: 'Acme', imageUrl: null, categoryPath: 'Health & Household › Vitamins',
  listedSince: '2025-02-01', trackingSince: '2025-02-03',
  currentPriceCents: 1999, avg30PriceCents: 2099, avg90PriceCents: 2199, avg180PriceCents: null, avg365PriceCents: null,
  salesRank: 1500, avg30SalesRank: 2000, avg90SalesRank: 2500, rankRatioX100: 75,
  reviewCount: 812, averageRatingX10: 45, lastRatingUpdate: '2026-10-01',
  monthlySold: 2000, keepaUpdatedAt: '2026-10-08', newOfferCount: 4, fbaOfferCount: 3, fbmOfferCount: 1, amazonAvailability: -1,
  enrichmentStatus: 'active', inCatalog: true, fetched: true, lastFetchedAt: '2026-10-08T06:00:00.000Z', fetchCount: 9, inScope: true, bestRank: 1234, tier: 1,
};
/** What loadProduct returns for an ASIN the keyword tables know but the catalog has no row for. */
const stubFacts: CatalogProductFacts = {
  asin: ASIN, title: 'Magnesium glycinate (keyword-side title)', brand: null, imageUrl: null, categoryPath: null, listedSince: null, trackingSince: null,
  currentPriceCents: null, avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null,
  salesRank: null, avg30SalesRank: null, avg90SalesRank: null, rankRatioX100: null, reviewCount: null, averageRatingX10: null, lastRatingUpdate: null,
  monthlySold: null, keepaUpdatedAt: null, newOfferCount: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null,
  enrichmentStatus: null, inCatalog: false, fetched: false, lastFetchedAt: null, fetchCount: 0, inScope: false, bestRank: null, tier: 0,
};

const point = (fetchedAt: string, over: Partial<HistoryPoint> = {}): HistoryPoint => ({
  fetchedAt, currentPriceCents: 1999, salesRank: 1500, reviewCount: 800, averageRatingX10: 45, monthlySold: 2000,
  newOfferCount: 4, fbaOfferCount: 3, fbmOfferCount: 1, enrichmentStatus: 'active', ...over,
});
const points = [point('2026-09-01T06:00:00.000Z', { currentPriceCents: 2499 }), point('2026-09-15T06:00:00.000Z'), point('2026-10-08T06:00:00.000Z', { salesRank: 1200 })];

const keywordRow = (n: number, over: Partial<ProductKeywordRow> = {}): ProductKeywordRow => ({
  searchTermId: `11111111-1111-4111-8111-00000000000${n}`, searchTermRaw: `magnesium ${n}`, currentRank: 100 * n, estimatedMonthlySearches: 50_000 / n,
  slot: 1, clickSharePct: 20.5, conversionSharePct: 18.25, weeksInTop3: n, streakStartedWeek: '2026-08-01', ...over,
});

function makeDeps(over: Partial<ProductsDeps> = {}): ProductsDeps {
  return {
    appUrl: APP,
    search: vi.fn(async () => ({ rows: pageRows, total: 2, totalIsCapped: false, page: 1, pageSize: PRODUCT_PAGE_SIZE })),
    facts: vi.fn(async () => catalogFacts),
    history: vi.fn(async () => points),
    keywords: vi.fn(async () => ({ rows: [keywordRow(1), keywordRow(2, { slot: 3 })], total: 7 })),
    reserve: vi.fn(async () => undefined),
    record: vi.fn(),
    ...over,
  };
}

/** The first call's position in vitest's global call order, to prove one dependency ran before another. */
const firstCall = (fn: unknown): number => vi.mocked(fn as (...args: unknown[]) => unknown).mock.invocationCallOrder[0];

describe('searchProductsForTool', () => {
  it('maps the input onto the page filters, reserves the page before reading, and returns the rows with their ASIN page links', async () => {
    const deps = makeDeps();
    const out = await searchProductsForTool(deps, admin, { filters: { priceMin: 9.99, ratingMin: 4.5, listedWithinDays: 90 }, sort: 'bsr', dir: 'asc' });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, priceMinCents: 999, ratingMin: 45, age: 90, sort: 'bsr', dir: 'asc' });
    expect(out).toStrictEqual({
      schemaVersion: 1,
      products: [{ ...pageRows[0], url: `${APP}/products/B0AAAAAAA1` }, { ...pageRows[1], url: `${APP}/products/B0AAAAAAA2` }],
      total: { kind: 'exact', value: 2 },
      page: 1,
      pageSize: PRODUCT_PAGE_SIZE,
      adminOnly: true,
    });
    // Metered as search_keywords is: the page size reserved up front, before any read; the delivered rows recorded after.
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.reserve).toHaveBeenCalledWith(admin, PRODUCT_PAGE_SIZE);
    expect(firstCall(deps.reserve)).toBeLessThan(firstCall(deps.search));
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledWith(admin, out.products.length);
  });

  it('searches with exactly the page defaults for an empty input', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, {});
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS });
  });

  it('reports a capped count as at_least, and an empty page as an exact zero with zero rows recorded', async () => {
    const capped = makeDeps({ search: vi.fn(async () => ({ rows: [pageRows[0]], total: PRODUCT_COUNT_CAP, totalIsCapped: true, page: 4, pageSize: PRODUCT_PAGE_SIZE })) });
    const many = await searchProductsForTool(capped, admin, { page: 4 });
    expect(many.total).toStrictEqual({ kind: 'at_least', value: PRODUCT_COUNT_CAP });
    expect(many.page).toBe(4);
    expect(capped.record).toHaveBeenCalledWith(admin, 1);

    const empty = makeDeps({ search: vi.fn(async () => ({ rows: [], total: 0, totalIsCapped: false, page: 1, pageSize: PRODUCT_PAGE_SIZE })) });
    const none = await searchProductsForTool(empty, admin, {});
    expect(none.products).toStrictEqual([]);
    expect(none.total).toStrictEqual({ kind: 'exact', value: 0 });
    expect(empty.record).toHaveBeenCalledWith(admin, 0);
  });

  it('builds the links from an app URL with trailing slashes', async () => {
    const out = await searchProductsForTool(makeDeps({ appUrl: `${APP}//` }), admin, {});
    expect(out.products.map((p) => p.url)).toEqual([`${APP}/products/B0AAAAAAA1`, `${APP}/products/B0AAAAAAA2`]);
  });

  it('refuses a non-admin account with FORBIDDEN before anything runs (no reserve, read or record), whatever the input', async () => {
    for (const input of [{}, { filters: { priceMin: -1 } }, 'not an object']) {
      const deps = makeDeps();
      const err = await searchProductsForTool(deps, member, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResearchError);
      expect((err as ResearchError).toInfo()).toStrictEqual(FORBIDDEN_INFO);
      for (const fn of [deps.reserve, deps.search, deps.record]) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid input as INVALID_FILTERS with the field path, before reserving', async () => {
    const deps = makeDeps();
    await expect(searchProductsForTool(deps, admin, { filters: { priceMin: 9.999 } })).rejects.toMatchObject({
      code: 'INVALID_FILTERS',
      details: [expect.objectContaining({ path: 'filters.priceMin' })],
    });
    await expect(searchProductsForTool(deps, admin, { pageSize: 10 })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    await expect(searchProductsForTool(deps, admin, { filters: { priceMin: 50, priceMax: 20 } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    for (const fn of [deps.reserve, deps.search, deps.record]) expect(fn).not.toHaveBeenCalled();
  });

  it('stops at a refused reserve (RATE_LIMITED): no read, nothing recorded', async () => {
    const limited = new ResearchError('RATE_LIMITED', 'slow', { retryable: true, retryAfterSeconds: 30 });
    const deps = makeDeps({ reserve: vi.fn(async () => { throw limited; }) });
    await expect(searchProductsForTool(deps, admin, {})).rejects.toBe(limited);
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });
});

describe('productDetailsForTool', () => {
  it('returns the facts with the ASIN page link, the snapshots with their first and last, and the keywords with their links', async () => {
    const deps = makeDeps();
    const out = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(out).toStrictEqual({
      schemaVersion: 1,
      product: { ...catalogFacts, url: `${APP}/products/${ASIN}` },
      history: { points, first: points[0], last: points[2] },
      keywords: [
        { ...keywordRow(1), keywordUrl: `${APP}/explorer/keyword/${keywordRow(1).searchTermId}` },
        { ...keywordRow(2, { slot: 3 }), keywordUrl: `${APP}/explorer/keyword/${keywordRow(2).searchTermId}` },
      ],
      keywordsTotal: 7,
    });
    expect(deps.facts).toHaveBeenCalledWith(ASIN);
    expect(deps.history).toHaveBeenCalledWith(ASIN);
    expect(deps.keywords).toHaveBeenCalledWith(ASIN, PRODUCT_TOOL_KEYWORDS_CAP);
    expect(PRODUCT_TOOL_KEYWORDS_CAP).toBe(100);
    // Metered as get_keyword_details is: one row reserved before any read, one recorded after.
    expect(deps.reserve).toHaveBeenCalledWith(admin, 1);
    expect(firstCall(deps.reserve)).toBeLessThan(firstCall(deps.facts));
    expect(deps.record).toHaveBeenCalledWith(admin, 1);
  });

  it('answers a stub (keyword tables only, no catalog row) normally: inCatalog false, no history read, keywords as usual', async () => {
    const deps = makeDeps({ facts: vi.fn(async () => stubFacts) });
    const out = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(out.product).toStrictEqual({ ...stubFacts, url: `${APP}/products/${ASIN}` });
    expect(out.product.inCatalog).toBe(false);
    expect(out.history).toStrictEqual({ points: [], first: null, last: null });
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.keywords).toHaveBeenCalledWith(ASIN, PRODUCT_TOOL_KEYWORDS_CAP);
    expect(out.keywords.map((k) => k.keywordUrl)).toEqual([1, 2].map((n) => `${APP}/explorer/keyword/${keywordRow(n).searchTermId}`));
    expect(out.keywordsTotal).toBe(7);
    expect(deps.record).toHaveBeenCalledWith(admin, 1);
  });

  it('gives a catalog product without snapshots an empty history (first and last null), and one snapshot as both first and last', async () => {
    const none = await productDetailsForTool(makeDeps({ history: vi.fn(async () => []) }), admin, { asin: ASIN });
    expect(none.history).toStrictEqual({ points: [], first: null, last: null });
    const one = await productDetailsForTool(makeDeps({ history: vi.fn(async () => [points[1]]) }), admin, { asin: ASIN });
    expect(one.history).toStrictEqual({ points: [points[1]], first: points[1], last: points[1] });
  });

  it('answers an ASIN in neither table with NOT_FOUND: no further reads, nothing recorded', async () => {
    const deps = makeDeps({ facts: vi.fn(async () => null) });
    const err = await productDetailsForTool(deps, admin, { asin: ASIN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect((err as ResearchError).toInfo()).toStrictEqual({ code: 'NOT_FOUND', message: expect.stringContaining('ASIN'), retryable: false });
    for (const fn of [deps.history, deps.keywords, deps.record]) expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a non-admin account with FORBIDDEN before anything runs, whatever the input', async () => {
    for (const input of [{ asin: ASIN }, { asin: 'nope' }]) {
      const deps = makeDeps();
      const err = await productDetailsForTool(deps, member, input).catch((e: unknown) => e);
      expect((err as ResearchError).toInfo()).toStrictEqual(FORBIDDEN_INFO);
      for (const fn of [deps.reserve, deps.facts, deps.history, deps.keywords, deps.record]) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('rejects a malformed ASIN, a missing one or an extra key as INVALID_FILTERS, before reserving', async () => {
    const deps = makeDeps();
    for (const input of [{ asin: 'b0abcdef12' }, { asin: 'B0ABCDEF1' }, { asin: ASIN, marketplace: 'US' }, {}]) {
      await expect(productDetailsForTool(deps, admin, input), JSON.stringify(input)).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    }
    for (const fn of [deps.reserve, deps.facts]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('productUrlFor', () => {
  it('is the ASIN page under the app URL, trailing slashes stripped (as keywordUrlFor does)', () => {
    expect(productUrlFor(APP, ASIN)).toBe(`${APP}/products/${ASIN}`);
    expect(productUrlFor(`${APP}///`, ASIN)).toBe(`${APP}/products/${ASIN}`);
  });
});

describe('defaultProductsDeps', () => {
  it('has the app URL and the four loaders, and opens no client while wiring', () => {
    neonMock.neon.mockClear();
    const d = defaultProductsDeps('https://x/');
    expect(Object.keys(d).sort()).toEqual(['appUrl', 'facts', 'history', 'keywords', 'search']);
    expect(d.appUrl).toBe('https://x/');
    for (const k of ['search', 'facts', 'history', 'keywords'] as const) expect(typeof d[k]).toBe('function');
    expect(neonMock.neon).not.toHaveBeenCalled();
  });

  it('runs each loader through neon() on DATABASE_URL (mocked here), passing the ASIN and the keyword limit through', async () => {
    neonMock.neon.mockClear();
    neonMock.query.mockClear();
    const d = defaultProductsDeps(APP);
    await expect(d.facts(ASIN)).resolves.toBeNull();
    expect(neonMock.neon).toHaveBeenCalledWith('postgres://test');
    await expect(d.history(ASIN)).resolves.toEqual([]);
    await expect(d.keywords(ASIN, PRODUCT_TOOL_KEYWORDS_CAP)).resolves.toEqual({ rows: [], total: 0 });
    expect(neonMock.query).toHaveBeenCalledWith(expect.any(String), [ASIN, PRODUCT_TOOL_KEYWORDS_CAP]);
    await expect(d.search({ ...PRODUCT_DEFAULTS })).resolves.toMatchObject({ rows: [], total: 0, totalIsCapped: false, page: 1, pageSize: PRODUCT_PAGE_SIZE });
    for (const [, values] of neonMock.query.mock.calls.slice(0, -2)) expect(values?.[0]).toBe(ASIN);
  });
});
