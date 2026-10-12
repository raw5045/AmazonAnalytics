// lib/products/filters.test.ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import * as filterParams from './filterParams';
import * as filters from './filters';
import { MAX_CUSTOM_CATEGORY_IDS, MAX_LEAF_PATHS, MAX_LEAF_PATH_LENGTH } from '@/lib/explorer/parseFilters';
import {
  MAX_CATEGORY_PATH_LENGTH,
  PRODUCT_AGES,
  PRODUCT_DEFAULTS,
  PRODUCT_MAX_BROAD_CATEGORY_LENGTH,
  PRODUCT_MAX_CUSTOM_IDS,
  PRODUCT_MAX_LEAF_PATHS,
  PRODUCT_SORTS,
  parseProductFilters,
  productFiltersToSearchParams,
  productFiltersSchema,
  type ProductFilters,
} from './filters';

/** The query string as Next hands it to a page: repeated keys become string[] (Object.fromEntries would keep only the last `leaf`). */
function toSearchParamsLike(qs: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}
/** What a browser does: serialise to the query string, then parse that string back. */
const viaUrl = (f: ProductFilters): ProductFilters => parseProductFilters(toSearchParamsLike(productFiltersToSearchParams(f).toString()));
const ID1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID2 = 'ffffffff-0000-4111-8222-abcdefabcdef';

/** Every field set to a non-default value (prices: $19.99 and $20). */
const FULL: ProductFilters = {
  age: 365, soldMin: 100000, reviewsMax: 300, ratingMin: 35, ratingMax: 50,
  priceMinCents: 1999, priceMaxCents: 2000, bsrMin: 1, bsrMax: 50000, ratioMax: 70,
  dept: 'Home & Kitchen', broadCategory: 'Home', leafPaths: ['Home & Kitchen › Bath', 'Home & Kitchen › Lighting'], customCategoryIds: [ID1, ID2],
  fba: 'yes', amazon: 'no', sort: 'ratio', dir: 'asc', page: 7,
};

describe('parseProductFilters', () => {
  it('returns the defaults for an empty URL', () => {
    expect(parseProductFilters({})).toEqual(PRODUCT_DEFAULTS);
    expect(PRODUCT_DEFAULTS).toMatchObject({ sort: 'sold', dir: 'desc', page: 1 });
  });
  it('parses every filter and ignores junk', () => {
    const f = parseProductFilters({ age: '180', soldMin: '1000', reviewsMax: '300', ratingMin: '35', ratingMax: '50', priceMin: '9.99', priceMax: '40', bsrMin: '1', bsrMax: '50000', ratioMax: '70', fba: 'no', amazon: 'no', sort: 'listed', dir: 'asc', page: '3', junk: 'x' });
    expect(f).toEqual({ age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 35, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, dept: null, broadCategory: null, leafPaths: [], customCategoryIds: [], fba: 'no', amazon: 'no', sort: 'listed', dir: 'asc', page: 3 });
  });
  it('falls back per field on invalid values (never throws)', () => {
    const f = parseProductFilters({ age: '45', soldMin: '-1', reviewsMax: 'abc', ratingMin: '99', page: '0', sort: 'nope', dir: 'sideways', fba: 'maybe' });
    expect(f).toEqual(PRODUCT_DEFAULTS);
  });
  it('falls back per field, not all-or-nothing: a valid neighbour of a bad value survives', () => {
    expect(parseProductFilters({ age: '45', soldMin: '1000' })).toEqual({ ...PRODUCT_DEFAULTS, soldMin: 1000 });
  });
  it('caps page and the category path length (256 characters kept, 257 dropped, for leaf and dept alike)', () => {
    expect(parseProductFilters({ page: '999999' }).page).toBe(200);
    const atCap = 'x'.repeat(256);
    const overCap = 'x'.repeat(257);
    expect(parseProductFilters({ leaf: [atCap, overCap] }).leafPaths).toEqual([atCap]);
    expect(parseProductFilters({ dept: atCap }).dept).toBe(atCap);
    expect(parseProductFilters({ dept: overCap }).dept).toBeNull();
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
  it('ignores the retired cat key', () => expect(parseProductFilters({ cat: 'Tools › Bath' })).toEqual(PRODUCT_DEFAULTS));
  it('drops leaf and dept values containing control characters; surrounding whitespace is trimmed before the check', () => {
    expect(parseProductFilters({ leaf: ['a\u0000b', 'Tools › Bath'] }).leafPaths).toEqual(['Tools › Bath']);
    expect(parseProductFilters({ dept: 'x\u001fy' }).dept).toBeNull();
    expect(parseProductFilters({ dept: '\tTools\n', leaf: '\nTools › Bath\t' })).toMatchObject({ dept: 'Tools', leafPaths: ['Tools › Bath'] });
    expect(parseProductFilters({ dept: '\t\n' }).dept).toBeNull();
  });
  it('reads dept, repeated leaf and the comma-list custom (spec 2026-10-12 §3), and writes them back in a fixed order', () => {
    const f = parseProductFilters({ dept: ' Pet Supplies ', leaf: ['Pet Supplies › Dogs › Toys', ' Pet Supplies › Cats › Toys '], custom: `${ID1},${ID2.toUpperCase()}` });
    expect(f).toEqual({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', leafPaths: ['Pet Supplies › Dogs › Toys', 'Pet Supplies › Cats › Toys'], customCategoryIds: [ID1, ID2] });
    expect(productFiltersToSearchParams(f).toString()).toBe(
      `dept=Pet+Supplies&leaf=Pet+Supplies+%E2%80%BA+Dogs+%E2%80%BA+Toys&leaf=Pet+Supplies+%E2%80%BA+Cats+%E2%80%BA+Toys&custom=${ID1}%2C${ID2}`,
    );
    expect(viaUrl(f)).toEqual(f);
  });
  it('one leaf arrives as a string, several as an array; blanks and over-long paths are dropped, the rest kept', () => {
    expect(parseProductFilters({ leaf: 'Tools › Bath' }).leafPaths).toEqual(['Tools › Bath']);
    expect(parseProductFilters({ leaf: ['  ', 'x'.repeat(257), 'Tools › Bath'] }).leafPaths).toEqual(['Tools › Bath']);
    const input = Array.from({ length: 2001 }, (_, i) => `p${i}`);
    expect(parseProductFilters({ leaf: input }).leafPaths).toEqual(input.slice(0, 2000));
  });
  it('drops repeated leaf paths (compared after trimming), before the cap', () => {
    expect(parseProductFilters({ leaf: ['A › B', 'A › B', 'A › C'] }).leafPaths).toEqual(['A › B', 'A › C']);
    expect(parseProductFilters({ leaf: [' A › B', 'A › B '] }).leafPaths).toEqual(['A › B']);
    // A repeat ahead of 2,000 distinct paths still leaves all 2,000: the cap counts distinct paths.
    const distinct = Array.from({ length: 2000 }, (_, i) => `p${i}`);
    expect(parseProductFilters({ leaf: ['p0', ...distinct] }).leafPaths).toEqual(distinct);
  });
  it('custom keeps well-formed uuids only, lower-cased and deduplicated, at most 50', () => {
    // The last entry is ID1 one hex digit short.
    expect(parseProductFilters({ custom: `${ID1},nope,${ID1.toUpperCase()},${ID1.slice(0, -1)},` }).customCategoryIds).toEqual([ID1]);
    expect(parseProductFilters({ custom: '' }).customCategoryIds).toEqual([]);
    // Surrounding whitespace is trimmed and the hex letters lower-cased.
    expect(parseProductFilters({ custom: ' ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345 ' }).customCategoryIds).toEqual(['abcdef01-abcd-4bcd-8bcd-abcdef012345']);
    const many = Array.from({ length: 51 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);
    expect(parseProductFilters({ custom: many.join(',') }).customCategoryIds).toEqual(many.slice(0, 50));
  });
  it('reads only the first custom key when Next hands a repeated one as an array', () => {
    expect(parseProductFilters({ custom: [ID1, ID2] }).customCategoryIds).toEqual([ID1]);
  });
  it('dept is trimmed; blank or over-long values fall back to null', () => {
    expect(parseProductFilters({ dept: ' Tools ' }).dept).toBe('Tools');
    expect(parseProductFilters({ dept: '   ' }).dept).toBeNull();
    expect(parseProductFilters({ dept: 'x'.repeat(300) }).dept).toBeNull();
  });
  it('reads broad (one Brand Analytics code) trimmed; blank, over-long or control-character values fall back to null (spec 2026-10-12 broad category §5)', () => {
    expect(parseProductFilters({ broad: ' Pet Supplies ' }).broadCategory).toBe('Pet Supplies');
    expect(parseProductFilters({ broad: 'Home' })).toEqual({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    expect(parseProductFilters({ broad: '   ' }).broadCategory).toBeNull();
    expect(parseProductFilters({ broad: 'x'.repeat(255) }).broadCategory).toBe('x'.repeat(255));
    expect(parseProductFilters({ broad: 'x'.repeat(256) }).broadCategory).toBeNull();
    expect(parseProductFilters({ broad: 'x\u001fy' }).broadCategory).toBeNull();
    expect(parseProductFilters({ broad: ['Home', 'Toys'] }).broadCategory).toBe('Home'); // a repeated key: the first value
    expect(PRODUCT_DEFAULTS.broadCategory).toBeNull();
    expect(PRODUCT_MAX_BROAD_CATEGORY_LENGTH).toBe(255);
  });
  it('writes broad after dept and before leaf, and omits it when null', () => {
    expect(productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', broadCategory: 'Home', leafPaths: ['Pet Supplies › Dogs'] }).toString()).toBe(
      'dept=Pet+Supplies&broad=Home&leaf=Pet+Supplies+%E2%80%BA+Dogs',
    );
    expect(productFiltersToSearchParams(PRODUCT_DEFAULTS).toString()).toBe('');
    expect(parseProductFilters(Object.fromEntries(productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, broadCategory: 'Misc SDP' })))).toEqual({ ...PRODUCT_DEFAULTS, broadCategory: 'Misc SDP' });
  });
  it('hands back fresh arrays, never the defaults\u2019 own', () => {
    const f = parseProductFilters({});
    expect(f.leafPaths).toEqual([]);
    expect(f.leafPaths).not.toBe(PRODUCT_DEFAULTS.leafPaths);
    expect(f.customCategoryIds).not.toBe(PRODUCT_DEFAULTS.customCategoryIds);
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
    expect(sp.toString()).toBe(
      `age=365&soldMin=100000&reviewsMax=300&ratingMin=35&ratingMax=50&priceMin=19.99&priceMax=20&bsrMin=1&bsrMax=50000&ratioMax=70&dept=Home+%26+Kitchen&broad=Home&leaf=Home+%26+Kitchen+%E2%80%BA+Bath&leaf=Home+%26+Kitchen+%E2%80%BA+Lighting&custom=${ID1}%2C${ID2}&fba=yes&amazon=no&sort=ratio&dir=asc&page=7`,
    );
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
  it('schema: custom ids come out lower-cased, as in the workspace contracts', () => {
    expect(productFiltersSchema.shape.customCategoryIds.parse([ID2.toUpperCase()])).toEqual([ID2]);
  });
});

describe('the zod-free half (./filterParams)', () => {
  it('the schema infers exactly the explicit ProductFilters type', () => {
    expectTypeOf<z.infer<typeof productFiltersSchema>>().toEqualTypeOf<filterParams.ProductFilters>();
    expectTypeOf<z.infer<typeof productFiltersSchema>>().toEqualTypeOf<ProductFilters>();
  });

  it('PRODUCT_DEFAULTS satisfies the schema', () => {
    expect(productFiltersSchema.safeParse(PRODUCT_DEFAULTS).success).toBe(true);
  });

  it('the caps are the Explorer caps (leaf paths, custom ids, path length)', () => {
    expect([PRODUCT_MAX_LEAF_PATHS, PRODUCT_MAX_CUSTOM_IDS, MAX_CATEGORY_PATH_LENGTH]).toEqual([MAX_LEAF_PATHS, MAX_CUSTOM_CATEGORY_IDS, MAX_LEAF_PATH_LENGTH]);
  });

  it('this module re-exports every value of ./filterParams as the same object', () => {
    for (const [name, value] of Object.entries(filterParams)) {
      expect(filters[name as keyof typeof filters], name).toBe(value);
    }
  });
});
