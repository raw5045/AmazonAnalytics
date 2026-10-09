// lib/products/filters.test.ts
import { describe, it, expect } from 'vitest';
import { PRODUCT_DEFAULTS, PRODUCT_SORTS, parseProductFilters, productFiltersToSearchParams, productFiltersSchema } from './filters';

describe('parseProductFilters', () => {
  it('returns the defaults for an empty URL', () => {
    expect(parseProductFilters({})).toEqual(PRODUCT_DEFAULTS);
    expect(PRODUCT_DEFAULTS).toMatchObject({ sort: 'sold', dir: 'desc', page: 1 });
  });
  it('parses every filter and ignores junk', () => {
    const f = parseProductFilters({ age: '180', soldMin: '1000', reviewsMax: '300', ratingMin: '35', ratingMax: '50', priceMin: '9.99', priceMax: '40', bsrMin: '1', bsrMax: '50000', ratioMax: '70', cat: 'Tools › Bath', fba: 'no', amazon: 'no', sort: 'listed', dir: 'asc', page: '3', junk: 'x' });
    expect(f).toEqual({ age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 35, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, cat: 'Tools › Bath', fba: 'no', amazon: 'no', sort: 'listed', dir: 'asc', page: 3 });
  });
  it('falls back per field on invalid values (never throws)', () => {
    const f = parseProductFilters({ age: '45', soldMin: '-1', reviewsMax: 'abc', ratingMin: '99', page: '0', sort: 'nope', dir: 'sideways', fba: 'maybe' });
    expect(f).toEqual(PRODUCT_DEFAULTS);
  });
  it('caps page and the category path length', () => {
    expect(parseProductFilters({ page: '999999' }).page).toBe(200);
    expect(parseProductFilters({ cat: 'x'.repeat(300) }).cat).toBeNull();
  });
  it('round-trips through search params (defaults omitted)', () => {
    const f = parseProductFilters({ age: '90', soldMin: '500', sort: 'reviews', dir: 'asc', page: '2' });
    const sp = productFiltersToSearchParams(f);
    expect(sp.toString()).toBe('age=90&soldMin=500&sort=reviews&dir=asc&page=2');
    expect(parseProductFilters(Object.fromEntries(sp))).toEqual(f);
  });
  it('schema: sorts are the fixed set', () => {
    expect(PRODUCT_SORTS).toEqual(['sold', 'listed', 'reviews', 'price', 'bsr', 'ratio', 'keywords']);
    expect(productFiltersSchema.safeParse({ ...PRODUCT_DEFAULTS, sort: 'x' }).success).toBe(false);
  });
});
