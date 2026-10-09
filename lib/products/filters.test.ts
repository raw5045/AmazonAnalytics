// lib/products/filters.test.ts
import { describe, it, expect } from 'vitest';
import {
  PRODUCT_AGES,
  PRODUCT_DEFAULTS,
  PRODUCT_SORTS,
  parseProductFilters,
  productFiltersToSearchParams,
  productFiltersSchema,
  type ProductFilters,
} from './filters';

/** What a browser does: serialise to the query string, then parse that string back. */
const viaUrl = (f: ProductFilters): ProductFilters =>
  parseProductFilters(Object.fromEntries(new URLSearchParams(productFiltersToSearchParams(f).toString())));

/** Every field set to a non-default value (prices: $19.99 and $20). */
const FULL: ProductFilters = {
  age: 365, soldMin: 100000, reviewsMax: 300, ratingMin: 35, ratingMax: 50,
  priceMinCents: 1999, priceMaxCents: 2000, bsrMin: 1, bsrMax: 50000, ratioMax: 70,
  cat: 'Home & Kitchen › Bath', fba: 'yes', amazon: 'no', sort: 'ratio', dir: 'asc', page: 7,
};

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
  it('falls back per field, not all-or-nothing: a valid neighbour of a bad value survives', () => {
    expect(parseProductFilters({ age: '45', soldMin: '1000' })).toEqual({ ...PRODUCT_DEFAULTS, soldMin: 1000 });
  });
  it('caps page and the category path length', () => {
    expect(parseProductFilters({ page: '999999' }).page).toBe(200);
    expect(parseProductFilters({ cat: 'x'.repeat(300) }).cat).toBeNull();
  });
  it('clamps any all-digit page to the last page, however long; anything else is page 1', () => {
    expect(parseProductFilters({ page: '200' }).page).toBe(200);
    expect(parseProductFilters({ page: '201' }).page).toBe(200);
    expect(parseProductFilters({ page: '12345678901' }).page).toBe(200);
    expect(parseProductFilters({ page: '9'.repeat(400) }).page).toBe(200);
    for (const bad of ['0', '-5', '3.5', 'abc', '', ' 7']) expect(parseProductFilters({ page: bad }).page).toBe(1);
  });
  it('takes no signs: negatives and -0 are dropped, a plain 0 stays', () => {
    expect(parseProductFilters({ soldMin: '-5', bsrMin: '-1', ratioMax: '-70', reviewsMax: '-0', ratingMin: '-0', ratingMax: '-3' })).toEqual(PRODUCT_DEFAULTS);
    expect(parseProductFilters({ reviewsMax: '0', ratingMin: '0' })).toEqual({ ...PRODUCT_DEFAULTS, reviewsMax: 0, ratingMin: 0 });
  });
  it('age accepts exactly the PRODUCT_AGES buckets', () => {
    for (const a of PRODUCT_AGES) expect(parseProductFilters({ age: String(a) }).age).toBe(a);
    for (const bad of ['0', '30', '61', '364', '366']) expect(parseProductFilters({ age: bad }).age).toBeNull();
  });
  it('trims the category path; a whitespace-only value is dropped', () => {
    expect(parseProductFilters({ cat: '  Tools › Bath ' }).cat).toBe('Tools › Bath');
    expect(parseProductFilters({ cat: '   ' }).cat).toBeNull();
    expect(parseProductFilters({ cat: '\t\n' }).cat).toBeNull();
  });
  it('reads prices as dollars (up to 8 integer digits); the schema bound decides what is too large', () => {
    expect(parseProductFilters({ priceMin: '0' }).priceMinCents).toBe(0);
    expect(parseProductFilters({ priceMin: '19.9' }).priceMinCents).toBe(1990);
    expect(parseProductFilters({ priceMax: '21474836.47' }).priceMaxCents).toBe(2_147_483_647);
    for (const bad of ['21474836.48', '99999999.99', '123456789', '-5', '1e3', '.5', '5.', '1.005', '']) {
      expect(parseProductFilters({ priceMax: bad }).priceMaxCents).toBeNull();
    }
  });
  it('PRODUCT_DEFAULTS is frozen and parse hands back a fresh object', () => {
    expect(Object.isFrozen(PRODUCT_DEFAULTS)).toBe(true);
    const parsed = parseProductFilters({});
    expect(parsed).not.toBe(PRODUCT_DEFAULTS);
    parsed.page = 9;
    expect(PRODUCT_DEFAULTS.page).toBe(1);
  });
  it('round-trips through search params (defaults omitted)', () => {
    const f = parseProductFilters({ age: '90', soldMin: '500', sort: 'reviews', dir: 'asc', page: '2' });
    const sp = productFiltersToSearchParams(f);
    expect(sp.toString()).toBe('age=90&soldMin=500&sort=reviews&dir=asc&page=2');
    expect(parseProductFilters(Object.fromEntries(sp))).toEqual(f);
  });
  it('round-trips every field through the URL string, prices as dollars, in a fixed param order', () => {
    expect(productFiltersSchema.safeParse(FULL).success).toBe(true);
    const sp = productFiltersToSearchParams(FULL);
    expect(sp.get('priceMin')).toBe('19.99');
    expect(sp.get('priceMax')).toBe('20');
    expect(sp.toString()).toBe('age=365&soldMin=100000&reviewsMax=300&ratingMin=35&ratingMax=50&priceMin=19.99&priceMax=20&bsrMin=1&bsrMax=50000&ratioMax=70&cat=Home+%26+Kitchen+%E2%80%BA+Bath&fba=yes&amazon=no&sort=ratio&dir=asc&page=7');
    expect(viaUrl(FULL)).toEqual(FULL);
  });
  it('round-trips the zeros that mean something (reviewsMax=0, ratingMin=0, priceMin=0)', () => {
    const zeros: ProductFilters = { ...PRODUCT_DEFAULTS, reviewsMax: 0, ratingMin: 0, priceMinCents: 0 };
    const sp = productFiltersToSearchParams(zeros);
    expect(sp.get('priceMin')).toBe('0');
    expect(sp.toString()).toBe('reviewsMax=0&ratingMin=0&priceMin=0');
    expect(viaUrl(zeros)).toEqual(zeros);
  });
  it('round-trips a price at the schema ceiling (8-digit dollars)', () => {
    const top: ProductFilters = { ...PRODUCT_DEFAULTS, priceMaxCents: 2_147_483_647 };
    expect(productFiltersToSearchParams(top).get('priceMax')).toBe('21474836.47');
    expect(viaUrl(top)).toEqual(top);
  });
  it('schema: sorts are the fixed set', () => {
    expect(PRODUCT_SORTS).toEqual(['sold', 'listed', 'reviews', 'price', 'bsr', 'ratio', 'keywords']);
    expect(productFiltersSchema.safeParse({ ...PRODUCT_DEFAULTS, sort: 'x' }).success).toBe(false);
  });
});
