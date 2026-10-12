// lib/research/products.test.ts
import { describe, it, expect, vi } from 'vitest';

// products.ts reads env only inside the default loaders (never at import). Both env and neon() are
// mocked, so no test here can reach a database: the fake neon client answers every query with [].
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const neonMock = vi.hoisted(() => {
  // neonRunner submits each read as a transaction of lazy query handles: query() hands back its own
  // statement, and transaction() answers every statement in the batch with no rows.
  const query = vi.fn<(text: string, values?: unknown[]) => { text: string; values?: unknown[] }>((text, values) => ({ text, values }));
  const transaction = vi.fn(async (statements: unknown[]) => statements.map(() => [] as unknown[]));
  return { query, transaction, neon: vi.fn(() => ({ query, transaction })) };
});
vi.mock('@neondatabase/serverless', () => ({ neon: neonMock.neon }));
// The category scope's production loaders (the hour-cached catalog lists, and the custom rows read over
// the research TCP pool) are stubbed as well, so the wiring test below calls them with no cache and no pool.
const scopeMock = vi.hoisted(() => ({
  departments: vi.fn(async () => ['Pet Supplies']),
  paths: vi.fn(async () => ['Pet Supplies › Cats › Toys']),
  broad: vi.fn(async () => ['Home']),
  customRows: vi.fn(async (userId: string, ids: string[]) => ids.map((id) => ({ id, leafPaths: [`${userId} path`] }))),
}));
vi.mock('@/lib/products/listCategories', () => ({
  listProductDepartments: scopeMock.departments, listProductCategoryPaths: scopeMock.paths, listProductBroadCategories: scopeMock.broad,
}));
vi.mock('./categories', () => ({ loadCustomRows: scopeMock.customRows }));

import { EMPTY_CATEGORY_SCOPE, type ProductCategoryScope } from '@/lib/products/categoryPredicate';
import { PRODUCT_DEFAULTS, PRODUCT_PAGE_SIZE, type ProductFilters } from '@/lib/products/filters';
import type { ProductFacts as CatalogProductFacts } from '@/lib/products/loadProduct';
import type { HistoryPoint } from '@/lib/products/loadProductHistory';
import type { ProductKeywordRow } from '@/lib/products/loadProductKeywords';
import { PRODUCT_COUNT_CAP, productSearchSql, type ProductSearchResult, type ProductSummaryRow } from '@/lib/products/searchProducts';
import type { CustomRow } from './categories';
import { ResearchError } from './errors';
import {
  defaultProductsDeps, PRODUCT_TOOL_HISTORY_POINTS, PRODUCT_TOOL_KEYWORDS_CAP, productDetailsForTool, searchProductsForTool, type ProductsDeps,
} from './products';
import type { ResearchActor } from './service';

const APP = 'https://keywordquarry.com';
const ASIN = 'B0ABCDEF12';
const admin: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp', isAdmin: true };
const member: ResearchActor = { ...admin, isAdmin: false };
const FORBIDDEN_INFO = { code: 'FORBIDDEN', message: 'Products tools are admin-only for now.', retryable: false };

const summaryRow = (asin: string, over: Partial<ProductSummaryRow> = {}): ProductSummaryRow => ({
  asin, title: `Product ${asin}`, brand: 'Acme', categoryPath: 'Health & Household › Vitamins', listedSince: '2026-06-01', monthlySold: 1000, reviewCount: 120, averageRatingX10: 46,
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
  broadCategories: [],
};
/** What loadProduct returns for an ASIN the keyword tables know but the catalog has no row for. */
const stubFacts: CatalogProductFacts = {
  asin: ASIN, title: 'Magnesium glycinate (keyword-side title)', brand: null, imageUrl: null, categoryPath: null, listedSince: null, trackingSince: null,
  currentPriceCents: null, avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null,
  salesRank: null, avg30SalesRank: null, avg90SalesRank: null, rankRatioX100: null, reviewCount: null, averageRatingX10: null, lastRatingUpdate: null,
  monthlySold: null, keepaUpdatedAt: null, newOfferCount: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null,
  enrichmentStatus: null, inCatalog: false, fetched: false, lastFetchedAt: null, fetchCount: 0, inScope: false, bestRank: null, tier: 0,
  broadCategories: [],
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

/** The catalog's departments and category paths, as the cached lists hold them (code-unit order). */
const DEPARTMENTS = ['Health & Household', 'Pet Supplies'];
/** The pair table's Brand Analytics codes, as the cached list holds them (code-unit order). */
const BROAD_CODES = ['Apparel', 'Home', 'Pet Supplies'];
const CATALOG_PATHS = [
  'Health & Household', 'Health & Household › Vitamins', 'Health & Household › Vitamins › Magnesium',
  'Pet Supplies › Cats › Toys', 'Pet Supplies › Dogs › Toys', 'Pet Supplies › Dogs › Toys › Chew Toys',
];
/** The admin's own custom category (hex letters, so an upper-cased copy differs); OTHER_ID is no category of theirs. */
const CUSTOM_ID = 'abcdef12-1111-4111-8111-000000000001';
const OTHER_ID = '22222222-2222-4222-8222-000000000002';

function makeDeps(over: Partial<ProductsDeps> = {}): ProductsDeps {
  return {
    appUrl: APP,
    search: vi.fn<(filters: ProductFilters, scope: ProductCategoryScope) => Promise<ProductSearchResult>>(async () => ({ rows: pageRows, total: 2, totalIsCapped: false, page: 1, pageSize: PRODUCT_PAGE_SIZE })),
    facts: vi.fn(async () => catalogFacts),
    history: vi.fn(async () => points),
    keywords: vi.fn(async () => ({ rows: [keywordRow(1), keywordRow(2, { slot: 3 })], total: 7 })),
    departments: vi.fn(async () => DEPARTMENTS),
    categoryPaths: vi.fn(async () => CATALOG_PATHS),
    broadCategories: vi.fn(async () => BROAD_CODES),
    // Owner-scoped, as loadCustomRows is: the admin's own id has rows; an unknown or foreign id is simply absent.
    customRows: vi.fn(async (userId: string, ids: string[]): Promise<CustomRow[]> => (
      userId === admin.localUserId && ids.includes(CUSTOM_ID) ? [{ id: CUSTOM_ID, leafPaths: ['Pet Supplies › Dogs › Toys › Chew Toys', 'Pet Supplies › Cats › Toys'] }] : []
    )),
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
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, priceMinCents: 999, ratingMin: 45, age: 90, sort: 'bsr', dir: 'asc' }, EMPTY_CATEGORY_SCOPE);
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
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, EMPTY_CATEGORY_SCOPE);
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
    for (const input of [{}, { filters: { priceMin: -1 } }, 'not an object', { filters: { department: 'Pet Supplies', categories: { leafPaths: ['Pet Supplies › Cats › Toys'] } } }, { filters: { broadCategory: 'Home' } }]) {
      const deps = makeDeps();
      const err = await searchProductsForTool(deps, member, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResearchError);
      expect((err as ResearchError).toInfo()).toStrictEqual(FORBIDDEN_INFO);
      for (const fn of [deps.reserve, deps.departments, deps.categoryPaths, deps.broadCategories, deps.customRows, deps.search, deps.record]) expect(fn).not.toHaveBeenCalled();
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

  it('stops at a refused reserve (RATE_LIMITED): no category or search read, nothing recorded', async () => {
    const limited = new ResearchError('RATE_LIMITED', 'slow', { retryable: true, retryAfterSeconds: 30 });
    const deps = makeDeps({ reserve: vi.fn(async () => { throw limited; }) });
    await expect(searchProductsForTool(deps, admin, {})).rejects.toBe(limited);
    const scoped = { filters: { department: 'Pet Supplies', broadCategory: 'Home', categories: { selections: [{ kind: 'custom', id: CUSTOM_ID }], leafPaths: ['Pet Supplies › Cats › Toys'] } } };
    await expect(searchProductsForTool(deps, admin, scoped)).rejects.toBe(limited);
    for (const fn of [deps.departments, deps.categoryPaths, deps.broadCategories, deps.customRows, deps.search, deps.record]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('searchProductsForTool: department and categories (spec 2026-10-12 §6)', () => {
  const notAvailable = async (deps: ProductsDeps, input: unknown) => {
    const err = await searchProductsForTool(deps, admin, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect((err as ResearchError).code).toBe('CATEGORY_NOT_AVAILABLE');
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    return err as ResearchError;
  };

  it('a department is checked against the catalog list and becomes dept; the scope is otherwise empty', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { department: 'Pet Supplies' } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' }, { dept: 'Pet Supplies', subtreePaths: [], exactPaths: [], scoped: false });
    expect(deps.categoryPaths).not.toHaveBeenCalled();
    expect(deps.customRows).not.toHaveBeenCalled();
  });
  it('an unknown department fails with the valid names in the message and the field in details', async () => {
    const err = await notAvailable(makeDeps(), { filters: { department: 'Pets' } });
    expect(err.message).toContain('"Pets"');
    expect(err.message).toContain('Health & Household; Pet Supplies');
    expect(err.details).toEqual([{ path: 'filters.department', message: 'unknown department' }]);
  });
  it('with no departments in the catalog yet, says so instead of listing none', async () => {
    const err = await notAvailable(makeDeps({ departments: vi.fn(async () => []) }), { filters: { department: 'Pet Supplies' } });
    expect(err.message).toBe('The product catalog has no departments yet.');
    expect(err.details).toEqual([{ path: 'filters.department', message: 'unknown department' }]);
  });
  it('a broad category is checked against the pair table\'s code list and becomes broadCategory; the scope is untouched (spec 2026-10-12 broad category §9)', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { broadCategory: 'Home', department: 'Pet Supplies' } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', broadCategory: 'Home' }, { dept: 'Pet Supplies', subtreePaths: [], exactPaths: [], scoped: false });
    expect(deps.broadCategories).toHaveBeenCalledTimes(1);
  });
  it('an unknown broad category fails with the valid codes in the message and the field in details; the list is not read for a search without one', async () => {
    const err = await notAvailable(makeDeps(), { filters: { broadCategory: 'Pets' } });
    expect(err.message).toBe('"Pets" is not a broad category of this week\'s clicked products. Pass one of: Apparel; Home; Pet Supplies.');
    expect(err.details).toEqual([{ path: 'filters.broadCategory', message: 'unknown broad category' }]);
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, {});
    expect(deps.broadCategories).not.toHaveBeenCalled();
  });
  it('with no codes on the pair table yet, says so instead of listing none', async () => {
    const err = await notAvailable(makeDeps({ broadCategories: vi.fn(async () => []) }), { filters: { broadCategory: 'Home' } });
    expect(err.message).toBe('No broad categories are available yet (the weekly keyword-to-product table is empty).');
    expect(err.details).toEqual([{ path: 'filters.broadCategory', message: 'unknown broad category' }]);
  });
  it('a blank broad category is INVALID_FILTERS, before reserving', async () => {
    const deps = makeDeps();
    const err = await searchProductsForTool(deps, admin, { filters: { broadCategory: '  ' } }).catch((e: unknown) => e);
    expect((err as ResearchError).code).toBe('INVALID_FILTERS');
    expect(deps.reserve).not.toHaveBeenCalled();
  });
  it('taxonomy selections are always subtrees (includeDescendants is ignored); leafPaths are exact; all checked against the catalog', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, {
      filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs › Toys' }, { kind: 'taxonomy', path: 'Health & Household › Vitamins', includeDescendants: false }], leafPaths: ['Pet Supplies › Cats › Toys'] } },
    });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: ['Pet Supplies › Dogs › Toys', 'Health & Household › Vitamins'], exactPaths: ['Pet Supplies › Cats › Toys'], scoped: true });
  });
  it('a subtree path may be a parent of catalog paths without being one itself; an exact path must be an entry', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs' }] } } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: ['Pet Supplies › Dogs'], exactPaths: [], scoped: true });
    // As resolve_categories returns a keyword-side leaf (includeDescendants false), even where the leaf is no product path itself.
    const keywordLeaf = makeDeps();
    await searchProductsForTool(keywordLeaf, admin, { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs', includeDescendants: false }] } } });
    expect(keywordLeaf.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: ['Pet Supplies › Dogs'], exactPaths: [], scoped: true });
    const err = await notAvailable(makeDeps(), { filters: { categories: { leafPaths: ['Pet Supplies › Dogs'] } } });
    expect(err.details).toEqual([{ path: 'filters.categories.leafPaths[0]', message: 'not a category path of the product catalog' }]);
  });
  it("a subtree path must meet catalog paths at a ' › ' boundary: a sibling's text prefix is refused", async () => {
    const err = await notAvailable(makeDeps(), { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dog' }] } } });
    expect(err.details).toEqual([{ path: 'filters.categories.selections[0].path', message: 'not a category path of the product catalog' }]);
  });
  it('names the offending entry at its own index', async () => {
    const custom = await notAvailable(makeDeps(), { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs › Toys' }, { kind: 'custom', id: OTHER_ID }] } } });
    expect(custom.details).toEqual([{ path: 'filters.categories.selections[1].id', message: 'unknown custom category id' }]);
    const leaf = await notAvailable(makeDeps(), { filters: { categories: { leafPaths: ['Pet Supplies › Cats › Toys', 'Pet Supplies › Birds'] } } });
    expect(leaf.details).toEqual([{ path: 'filters.categories.leafPaths[1]', message: 'not a category path of the product catalog' }]);
  });
  it('an unknown path fails, naming the field, and nothing runs', async () => {
    const err = await notAvailable(makeDeps(), { filters: { categories: { leafPaths: ['Pet Supplies › Birds'] } } });
    expect(err.message).toContain('"Pet Supplies › Birds"');
    expect(err.details).toEqual([{ path: 'filters.categories.leafPaths[0]', message: 'not a category path of the product catalog' }]);
  });
  it("a custom selection expands to the account's stored paths, exactly; an unknown or foreign id fails", async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { department: 'Pet Supplies', categories: { selections: [{ kind: 'custom', id: CUSTOM_ID.toUpperCase() }] } } });
    expect(deps.customRows).toHaveBeenCalledWith('u1', [CUSTOM_ID]);
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' }, { dept: 'Pet Supplies', subtreePaths: [], exactPaths: ['Pet Supplies › Dogs › Toys › Chew Toys', 'Pet Supplies › Cats › Toys'], scoped: true });
    const err = await notAvailable(makeDeps(), { filters: { categories: { selections: [{ kind: 'custom', id: OTHER_ID }] } } });
    expect(err.details).toEqual([{ path: 'filters.categories.selections[0].id', message: 'unknown custom category id' }]);
  });
  it('an owned custom category with no stored paths, or with paths the catalog lacks, scopes to nothing rather than erroring', async () => {
    const empty = makeDeps({ customRows: vi.fn(async () => [{ id: CUSTOM_ID, leafPaths: [] }]) });
    await searchProductsForTool(empty, admin, { filters: { categories: { selections: [{ kind: 'custom', id: CUSTOM_ID }] } } });
    expect(empty.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: [], exactPaths: [], scoped: true });
    // Stored paths are matched as stored, never checked against the catalog: a stale one simply matches nothing.
    const stale = makeDeps({ customRows: vi.fn(async () => [{ id: CUSTOM_ID, leafPaths: ['Pet Supplies › Birds'] }]) });
    await searchProductsForTool(stale, admin, { filters: { categories: { selections: [{ kind: 'custom', id: CUSTOM_ID }] } } });
    expect(stale.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: [], exactPaths: ['Pet Supplies › Birds'], scoped: true });
    expect(stale.categoryPaths).not.toHaveBeenCalled();
  });
  it('an empty categories object scopes nothing; paths are deduplicated', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { categories: {} } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, EMPTY_CATEGORY_SCOPE);
    const dup = makeDeps();
    await searchProductsForTool(dup, admin, { filters: { categories: { leafPaths: ['Pet Supplies › Cats › Toys', 'Pet Supplies › Cats › Toys'] } } });
    expect(dup.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: [], exactPaths: ['Pet Supplies › Cats › Toys'], scoped: true });
  });
  it("resolves the scope after the reserve and before the search (the keyword tools' order)", async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { department: 'Pet Supplies', broadCategory: 'Home' } });
    expect(firstCall(deps.reserve)).toBeLessThan(firstCall(deps.departments));
    expect(firstCall(deps.departments)).toBeLessThan(firstCall(deps.search));
    expect(firstCall(deps.reserve)).toBeLessThan(firstCall(deps.broadCategories));
    expect(firstCall(deps.broadCategories)).toBeLessThan(firstCall(deps.search));
  });
  it('lets a failed department, broad-category, path or custom-row read through unchanged (never a false CATEGORY_NOT_AVAILABLE): no search, nothing recorded', async () => {
    const boom = new Error('read failed');
    const fail = vi.fn(async () => { throw boom; });
    const cases: Array<[Partial<ProductsDeps>, unknown]> = [
      [{ departments: fail }, { filters: { department: 'Pet Supplies' } }],
      [{ broadCategories: fail }, { filters: { broadCategory: 'Home' } }],
      [{ categoryPaths: fail }, { filters: { categories: { leafPaths: ['Pet Supplies › Cats › Toys'] } } }],
      [{ customRows: fail }, { filters: { categories: { selections: [{ kind: 'custom', id: CUSTOM_ID }] } } }],
    ];
    for (const [over, input] of cases) {
      const deps = makeDeps(over);
      await expect(searchProductsForTool(deps, admin, input), JSON.stringify(input)).rejects.toBe(boom);
      expect(deps.search).not.toHaveBeenCalled();
      expect(deps.record).not.toHaveBeenCalled();
    }
  });
  it('the retired categoryPath field is rejected as INVALID_FILTERS', async () => {
    await expect(searchProductsForTool(makeDeps(), admin, { filters: { categoryPath: 'Pet Supplies' } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
});

describe('productDetailsForTool', () => {
  it('returns the facts with the ASIN page link, the snapshots with their first and last, and the keywords with their links', async () => {
    const deps = makeDeps();
    const out = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(out).toStrictEqual({
      schemaVersion: 1,
      product: { ...catalogFacts, url: `${APP}/products/${ASIN}` },
      history: { points, first: points[0], last: points[2], pointsTotal: 3 },
      keywords: [
        { ...keywordRow(1), keywordUrl: `${APP}/explorer/keyword/${keywordRow(1).searchTermId}` },
        { ...keywordRow(2, { slot: 3 }), keywordUrl: `${APP}/explorer/keyword/${keywordRow(2).searchTermId}` },
      ],
      keywordsTotal: 7,
    });
    expect(out.product.broadCategories).toEqual([]);
    expect(deps.facts).toHaveBeenCalledWith(ASIN);
    expect(deps.history).toHaveBeenCalledWith(ASIN);
    expect(deps.keywords).toHaveBeenCalledWith(ASIN, PRODUCT_TOOL_KEYWORDS_CAP);
    expect(PRODUCT_TOOL_KEYWORDS_CAP).toBe(100);
    // Metered as get_keyword_details is: one row reserved before any read, one recorded after.
    expect(deps.reserve).toHaveBeenCalledWith(admin, 1);
    expect(firstCall(deps.reserve)).toBeLessThan(firstCall(deps.facts));
    expect(deps.record).toHaveBeenCalledWith(admin, 1);
  });

  it('returns the facts\' broadCategories as the loader gives them (most keywords first)', async () => {
    const deps = makeDeps({ facts: vi.fn(async () => ({ ...catalogFacts, broadCategories: ['Home', 'Pet Supplies'] })) });
    const res = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(res.product.broadCategories).toEqual(['Home', 'Pet Supplies']);
  });

  it('answers a stub (keyword tables only, no catalog row) normally: inCatalog false, no history read, keywords as usual', async () => {
    const deps = makeDeps({ facts: vi.fn(async () => stubFacts) });
    const out = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(out.product).toStrictEqual({ ...stubFacts, url: `${APP}/products/${ASIN}` });
    expect(out.product.inCatalog).toBe(false);
    expect(out.history).toStrictEqual({ points: [], first: null, last: null, pointsTotal: 0 });
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.keywords).toHaveBeenCalledWith(ASIN, PRODUCT_TOOL_KEYWORDS_CAP);
    expect(out.keywords.map((k) => k.keywordUrl)).toEqual([1, 2].map((n) => `${APP}/explorer/keyword/${keywordRow(n).searchTermId}`));
    expect(out.keywordsTotal).toBe(7);
    expect(deps.record).toHaveBeenCalledWith(admin, 1);
  });

  it('gives a catalog product without snapshots an empty history (first and last null), and one snapshot as both first and last', async () => {
    const none = await productDetailsForTool(makeDeps({ history: vi.fn(async () => []) }), admin, { asin: ASIN });
    expect(none.history).toStrictEqual({ points: [], first: null, last: null, pointsTotal: 0 });
    const one = await productDetailsForTool(makeDeps({ history: vi.fn(async () => [points[1]]) }), admin, { asin: ASIN });
    expect(one.history).toStrictEqual({ points: [points[1]], first: points[1], last: points[1], pointsTotal: 1 });
  });

  it('skips the history read for a catalog product the service has never fetched (it has no snapshots)', async () => {
    const unfetched: CatalogProductFacts = { ...catalogFacts, fetched: false, lastFetchedAt: null, fetchCount: 0 };
    const deps = makeDeps({ facts: vi.fn(async () => unfetched) });
    const out = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(out.product).toStrictEqual({ ...unfetched, url: `${APP}/products/${ASIN}` });
    expect(out.history).toStrictEqual({ points: [], first: null, last: null, pointsTotal: 0 });
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.keywords).toHaveBeenCalledWith(ASIN, PRODUCT_TOOL_KEYWORDS_CAP);
    expect(deps.record).toHaveBeenCalledWith(admin, 1);
  });

  it('returns only the newest PRODUCT_TOOL_HISTORY_POINTS snapshots, oldest first, while first, last and pointsTotal span the whole loaded window', async () => {
    expect(PRODUCT_TOOL_HISTORY_POINTS).toBe(60);
    const weekly = (i: number) => point(new Date(Date.UTC(2025, 0, 6) + i * 7 * 86_400_000).toISOString(), { salesRank: 1000 + i });
    // The loader's own window: oldest first.
    const loaded = Array.from({ length: PRODUCT_TOOL_HISTORY_POINTS + 25 }, (_, i) => weekly(i));
    const capped = await productDetailsForTool(makeDeps({ history: vi.fn(async () => loaded) }), admin, { asin: ASIN });
    expect(capped.history.points).toHaveLength(PRODUCT_TOOL_HISTORY_POINTS);
    expect(capped.history).toStrictEqual({ points: loaded.slice(25), first: loaded[0], last: loaded.at(-1), pointsTotal: PRODUCT_TOOL_HISTORY_POINTS + 25 });
    // At the cap nothing is dropped, and first and last are the points' own ends.
    const atCap = loaded.slice(0, PRODUCT_TOOL_HISTORY_POINTS);
    const whole = await productDetailsForTool(makeDeps({ history: vi.fn(async () => atCap) }), admin, { asin: ASIN });
    expect(whole.history).toStrictEqual({ points: atCap, first: atCap[0], last: atCap.at(-1), pointsTotal: PRODUCT_TOOL_HISTORY_POINTS });
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

describe('defaultProductsDeps', () => {
  it('has the eight loaders (no app URL: the service supplies its own), and opens no client while wiring', () => {
    neonMock.neon.mockClear();
    for (const fn of Object.values(scopeMock)) fn.mockClear();
    const d = defaultProductsDeps();
    const loaders = ['broadCategories', 'categoryPaths', 'customRows', 'departments', 'facts', 'history', 'keywords', 'search'] as const;
    expect(Object.keys(d).sort()).toEqual([...loaders]);
    for (const k of loaders) expect(typeof d[k]).toBe('function');
    expect(neonMock.neon).not.toHaveBeenCalled();
    for (const fn of Object.values(scopeMock)) expect(fn).not.toHaveBeenCalled();
  });

  it('wires the scope loaders to the cached catalog lists and to loadCustomRows, passing the user and the ids through', async () => {
    for (const fn of Object.values(scopeMock)) fn.mockClear();
    const d = defaultProductsDeps();
    await expect(d.departments()).resolves.toEqual(['Pet Supplies']);
    await expect(d.categoryPaths()).resolves.toEqual(['Pet Supplies › Cats › Toys']);
    await expect(d.broadCategories()).resolves.toEqual(['Home']);
    await expect(d.customRows('u1', [CUSTOM_ID])).resolves.toEqual([{ id: CUSTOM_ID, leafPaths: ['u1 path'] }]);
    expect(scopeMock.departments).toHaveBeenCalledExactlyOnceWith();
    expect(scopeMock.paths).toHaveBeenCalledExactlyOnceWith();
    expect(scopeMock.broad).toHaveBeenCalledExactlyOnceWith();
    expect(scopeMock.customRows).toHaveBeenCalledExactlyOnceWith('u1', [CUSTOM_ID]);
  });

  it('runs each loader through neon() on DATABASE_URL (mocked here), passing the ASIN and the keyword limit through', async () => {
    neonMock.neon.mockClear();
    neonMock.query.mockClear();
    neonMock.transaction.mockClear();
    // Every read goes out as its own transaction behind SET LOCAL statement_timeout; `reads` are the statements themselves.
    const reads = () => neonMock.query.mock.calls.filter(([text]) => !text.startsWith('SET LOCAL'));
    const d = defaultProductsDeps();
    await expect(d.facts(ASIN)).resolves.toBeNull();
    expect(neonMock.neon).toHaveBeenCalledWith('postgres://test');
    await expect(d.history(ASIN)).resolves.toEqual([]);
    await expect(d.keywords(ASIN, PRODUCT_TOOL_KEYWORDS_CAP)).resolves.toEqual({ rows: [], total: 0 });
    expect(neonMock.query).toHaveBeenCalledWith(expect.any(String), [ASIN, PRODUCT_TOOL_KEYWORDS_CAP]);
    const asinReads = reads().length;
    // A non-empty scope, so a default search dep that dropped it would build different statements (with the empty scope they would match).
    const SCOPE: ProductCategoryScope = { ...EMPTY_CATEGORY_SCOPE, subtreePaths: ['Tools › Bath'], scoped: true };
    await expect(d.search({ ...PRODUCT_DEFAULTS }, SCOPE)).resolves.toMatchObject({ rows: [], total: 0, totalIsCapped: false, page: 1, pageSize: PRODUCT_PAGE_SIZE });
    // facts, history and keywords bind the ASIN first; the search then runs exactly its two statements, rows before count.
    for (const [, values] of reads().slice(0, asinReads)) expect(values?.[0]).toBe(ASIN);
    const search = productSearchSql({ ...PRODUCT_DEFAULTS }, SCOPE);
    expect(search.rows.values).toContain('Tools › Bath');
    expect(reads().slice(asinReads)).toStrictEqual([[search.rows.text, search.rows.values], [search.count.text, search.count.values]]);
    expect(neonMock.transaction).toHaveBeenCalledTimes(reads().length);
  });
});
