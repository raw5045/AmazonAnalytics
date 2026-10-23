// lib/products/replayQuery.test.ts
import { describe, expect, it } from 'vitest';
import { pageCategoryScope } from './categoryPredicate';
import { parseProductFilters, PRODUCT_DEFAULTS, productFiltersToSearchParams, type ProductFilters } from './filters';
import { parseRecordedProductSearch, scopeForReplay } from './replayQuery';

const ID1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID2 = 'ffffffff-0000-4111-8222-abcdefabcdef';

describe('parseRecordedProductSearch', () => {
  it("reads a page string as the list page reads its URL: repeated leaf picks kept, the comma-joined custom ids split, no leafExact", () => {
    const filters: ProductFilters = {
      ...PRODUCT_DEFAULTS, age: 60, soldMin: 30_000, priceMaxCents: 1999, broadCategory: 'Home', leafPaths: ['Tools › Bath', 'Tools › Kitchen'], customCategoryIds: [ID1, ID2], sort: 'keywords', dir: 'asc', page: 3,
    };
    const query = productFiltersToSearchParams(filters).toString();
    expect(parseRecordedProductSearch(query)).toStrictEqual({ filters, leafExact: [], cut: false });
    // What the page itself makes of the same string (Next hands it the repeated leaf as a list).
    const sp = new URLSearchParams(query);
    expect(parseRecordedProductSearch(query).filters).toStrictEqual(parseProductFilters({ ...Object.fromEntries(sp), leaf: sp.getAll('leaf') }));
  });

  it('takes the tool-only leafExact values out (de-duplicated) before the page parse, wherever they sit', () => {
    const query = new URLSearchParams([
      ['broad', 'Home'], ['leafExact', 'Tools › Bath › Mats'], ['sort', 'price'], ['leaf', 'Tools › Bath'], ['custom', `${ID1},${ID2}`],
      ['leafExact', 'Health & Household › Vitamins'], ['leafExact', 'Tools › Bath › Mats'],
    ]).toString();
    expect(parseRecordedProductSearch(query)).toStrictEqual({
      filters: { ...PRODUCT_DEFAULTS, broadCategory: 'Home', leafPaths: ['Tools › Bath'], customCategoryIds: [ID1, ID2], sort: 'price' },
      leafExact: ['Tools › Bath › Mats', 'Health & Household › Vitamins'],
      cut: false,
    });
  });

  it("an empty string is the default list; a bad value falls back to its default, as on the page", () => {
    expect(parseRecordedProductSearch('')).toStrictEqual({ filters: { ...PRODUCT_DEFAULTS }, leafExact: [], cut: false });
    expect(parseRecordedProductSearch('age=45&sort=nope&soldMin=1000').filters).toStrictEqual({ ...PRODUCT_DEFAULTS, soldMin: 1000 });
  });

  it("flags a string the recorder cut: it ends with ' ...[+N chars]'; the marker anywhere else, or malformed, is not one", () => {
    expect(parseRecordedProductSearch('sort=price&leafExact=Tools+%E2%80%BA+Ba ...[+1234 chars]').cut).toBe(true);
    expect(parseRecordedProductSearch('sort=price ...[+1 chars]').cut).toBe(true);
    for (const whole of ['sort=price', 'sort=price ...[+12 chars]&page=2', 'sort=price...[+12 chars]', 'sort=price ...[+ chars]', 'sort=price ...[12 chars]']) {
      expect(parseRecordedProductSearch(whole).cut, whole).toBe(false);
    }
  });
});

describe('scopeForReplay', () => {
  const filters: ProductFilters = { ...PRODUCT_DEFAULTS, dept: 'Tools', leafPaths: ['Tools › Bath'], customCategoryIds: [ID1] };

  it("is the page's scope with the leafExact paths added to the exact ones (the custom paths first, de-duplicated)", () => {
    const customPaths = ['Tools › Kitchen › Sinks', 'Tools › Bath › Mats'];
    expect(scopeForReplay(filters, customPaths, ['Tools › Bath › Mats', 'Health & Household › Vitamins'])).toStrictEqual({
      dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: ['Tools › Kitchen › Sinks', 'Tools › Bath › Mats', 'Health & Household › Vitamins'], scoped: true,
    });
  });

  it("without leafExact it is exactly the page's scope; leafExact alone makes a scoped search", () => {
    expect(scopeForReplay(filters, ['Tools › Kitchen'], [])).toStrictEqual(pageCategoryScope(filters, ['Tools › Kitchen']));
    expect(scopeForReplay({ ...PRODUCT_DEFAULTS }, [], [])).toStrictEqual(pageCategoryScope(PRODUCT_DEFAULTS, []));
    expect(scopeForReplay({ ...PRODUCT_DEFAULTS }, [], ['Tools › Bath'])).toStrictEqual({ dept: null, subtreePaths: [], exactPaths: ['Tools › Bath'], scoped: true });
  });
});
