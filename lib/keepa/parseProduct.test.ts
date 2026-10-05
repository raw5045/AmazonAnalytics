// lib/keepa/parseProduct.test.ts
/**
 * Parser tests against lib/keepa/__fixtures__/batch-stats.json — captured on 2026-10 with the
 * service's exact request (rating=1, stats=90, history=0). Live values drift, so the first
 * fixture test is structural (status, non-null, ranges) and survives a re-capture; the
 * exact-mapping test pins every field of this capture and must be updated with one.
 */
import { describe, it, expect } from 'vitest';
import { parseProductFacts, parseKeepaBatch, keepaMinutesToDate, primaryImageUrl, PRICE_TYPE } from './parseProduct';
import { emptyFacts, type ProductFacts } from './productFacts';
import fixture from './__fixtures__/batch-stats.json';

const products = (fixture as { products: unknown[] }).products;
const TOILET_PAPER = 'B07BGLT25K';
const rawFor = (asin: string) => products.find((p) => (p as { asin: string }).asin === asin);

describe('parseProductFacts on the captured batch', () => {
  it('reads the Scott toilet paper product from the product object and the stats arrays', () => {
    const f = parseProductFacts(rawFor(TOILET_PAPER), TOILET_PAPER);
    expect(f.status).toBe('active');
    expect(f.errorCode).toBeNull();
    expect(f.title).toContain('Scott');
    expect(f.categoryRoot).toBe('Health & Household');
    expect(f.categoryLeaf).toBe('Toilet Paper');
    expect(f.categoryPath).toBe('Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper');
    expect(f.listedSince).toBe('2018-03-19');
    expect(f.trackingSince).toBe('2018-04-23');
    expect(f.currentPriceCents).toBeGreaterThan(0);
    expect(['amazon', 'new']).toContain(f.priceSource);
    expect(f.salesRank).toBeGreaterThan(0);
    expect(f.reviewCount).toBeGreaterThan(100_000);
    expect(f.averageRatingX10).toBeGreaterThanOrEqual(35);
    expect(f.averageRatingX10).toBeLessThanOrEqual(50);
    expect(f.avg30PriceCents).toBeGreaterThan(0);
    expect(f.avg90SalesRank).toBeGreaterThan(0);
    expect(f.newOfferCount).toBeGreaterThanOrEqual(0);
    expect(f.fbaOfferCount).toBeGreaterThanOrEqual(0);
    expect(f.fbmOfferCount).toBe(0);
    expect(f.keepaUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.imageUrl).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\//);
    expect([-1, 0, 1, 2, 3, 4, null]).toContain(f.amazonAvailability);
  });

  it('maps every field of the Scott product exactly (values read from this capture)', () => {
    const expected: ProductFacts = {
      asin: TOILET_PAPER,
      status: 'active',
      errorCode: null,
      title: 'Scott ComfortPlus Toilet Paper, 12 Triple Rolls, 231 Sheets per Roll, Septic-Safe, 1-Ply Toilet Tissue',
      brand: 'Scott',
      imageUrl: 'https://m.media-amazon.com/images/I/41nsNU3erjL.jpg',
      categoryPath: 'Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper',
      categoryRoot: 'Health & Household',
      categoryLeaf: 'Toilet Paper',
      listedSince: '2018-03-19',
      trackingSince: '2018-04-23',
      currentPriceCents: 568,
      priceSource: 'amazon',
      salesRank: 2,
      reviewCount: 141_297,
      averageRatingX10: 45,
      lastRatingUpdate: '2026-10-05',
      monthlySold: 100_000,
      keepaUpdatedAt: '2026-10-05',
      newOfferCount: 1,
      fbaOfferCount: 1,
      fbmOfferCount: 0,
      amazonAvailability: 0,
      avg30PriceCents: 591,
      avg90PriceCents: 596,
      avg180PriceCents: 596,
      avg365PriceCents: 607,
      avg30SalesRank: 2,
      avg90SalesRank: 2,
    };
    expect(parseProductFacts(rawFor(TOILET_PAPER), TOILET_PAPER)).toEqual(expected);
  });

  it('parses the second product, which Keepa marks invalid (productType 4), as delisted', () => {
    const raw = products[1] as { asin: string; productType: number };
    expect(raw.productType).toBe(4);
    expect(parseProductFacts(raw, raw.asin)).toEqual(emptyFacts(raw.asin, 'delisted'));
  });
});

describe('parseProductFacts validation (spec §5.1 step 5)', () => {
  const base = (over: Record<string, unknown>) => ({ asin: 'B000000001', ...over });

  it('a product without a price in either series is no_price, facts still kept', () => {
    const f = parseProductFacts(base({ title: 'T', stats: { current: [-1, -1, -1, 123] } }), 'B000000001');
    expect(f.status).toBe('no_price');
    expect(f.currentPriceCents).toBeNull();
    expect(f.priceSource).toBeNull();
    expect(f.avg30PriceCents).toBeNull();
    expect(f.salesRank).toBe(123);
    expect(f.title).toBe('T');
  });

  it('falls back to the third-party new price and takes the averages from that series', () => {
    const avg30: number[] = []; avg30[PRICE_TYPE.AMAZON] = 999; avg30[PRICE_TYPE.NEW] = 1850;
    const f = parseProductFacts(base({ stats: { current: [-1, 1899], avg30 } }), 'B000000001');
    expect(f.status).toBe('active');
    expect(f.priceSource).toBe('new');
    expect(f.currentPriceCents).toBe(1899);
    expect(f.avg30PriceCents).toBe(1850);
  });

  it('with an Amazon price the averages come from the Amazon series, even when the New series differs', () => {
    const avg30: number[] = []; avg30[PRICE_TYPE.AMAZON] = 1250; avg30[PRICE_TYPE.NEW] = 1850;
    const avg365: number[] = []; avg365[PRICE_TYPE.AMAZON] = 1150; avg365[PRICE_TYPE.NEW] = 1950;
    const f = parseProductFacts(base({ stats: { current: [1299, 1399], avg30, avg365 } }), 'B000000001');
    expect(f.priceSource).toBe('amazon');
    expect(f.currentPriceCents).toBe(1299);
    expect(f.avg30PriceCents).toBe(1250);
    expect(f.avg365PriceCents).toBe(1150);
  });

  it('nulls impossible values: negative counts, ratings off the 0–50 scale, non-positive prices and ranks; an offer count of −1 means none (0)', () => {
    const current = [0, -5]; current[PRICE_TYPE.SALES] = 0; current[PRICE_TYPE.COUNT_REVIEWS] = -1;
    current[PRICE_TYPE.RATING] = 51; current[PRICE_TYPE.COUNT_NEW] = -2; current[PRICE_TYPE.COUNT_NEW_FBM] = -1;
    const f = parseProductFacts(base({ stats: { current }, monthlySold: 0, availabilityAmazon: 9 }), 'B000000001');
    expect(f.status).toBe('no_price');
    expect(f.salesRank).toBeNull();
    expect(f.reviewCount).toBeNull();
    expect(f.averageRatingX10).toBeNull();
    expect(f.newOfferCount).toBeNull();
    expect(f.fbmOfferCount).toBe(0);
    expect(f.monthlySold).toBeNull();
    expect(f.amazonAvailability).toBeNull();
  });

  it('keeps the edges of every range: rating 0 and 50 (51 is null), availability −1 and 4 (5 is null), offer count 0, price 1', () => {
    const withSlot = (index: number, value: number, over: Record<string, unknown> = {}) => {
      const current: number[] = []; current[index] = value;
      return parseProductFacts(base({ stats: { current }, ...over }), 'B000000001');
    };
    expect(withSlot(PRICE_TYPE.RATING, 0).averageRatingX10).toBe(0);
    expect(withSlot(PRICE_TYPE.RATING, 50).averageRatingX10).toBe(50);
    expect(withSlot(PRICE_TYPE.RATING, 51).averageRatingX10).toBeNull();
    expect(withSlot(PRICE_TYPE.COUNT_NEW, 0).newOfferCount).toBe(0);
    expect(withSlot(PRICE_TYPE.AMAZON, 1).currentPriceCents).toBe(1);
    const availability = (a: number) => withSlot(PRICE_TYPE.AMAZON, 1, { availabilityAmazon: a }).amazonAvailability;
    expect(availability(-1)).toBe(-1);
    expect(availability(4)).toBe(4);
    expect(availability(5)).toBeNull();
  });

  it('reads the last csv value when the reply carried history instead of stats', () => {
    const csv: unknown[] = []; csv[PRICE_TYPE.AMAZON] = [100, 1299, 200, 1399]; csv[PRICE_TYPE.COUNT_NEW_FBA] = [100, 3];
    const f = parseProductFacts(base({ csv }), 'B000000001');
    expect(f.currentPriceCents).toBe(1399);
    expect(f.fbaOfferCount).toBe(3);
  });

  it('a stats slot holding −1 is final: the csv is read only for a slot that is absent', () => {
    const csv: unknown[] = []; csv[PRICE_TYPE.AMAZON] = [100, 1299];
    const f = parseProductFacts(base({ stats: { current: [-1] }, csv }), 'B000000001');
    expect(f.currentPriceCents).toBeNull();
    expect(f.status).toBe('no_price');
    csv[PRICE_TYPE.NEW] = [100, 1399];
    const g = parseProductFacts(base({ stats: { current: [-1] }, csv }), 'B000000001');
    expect(g.priceSource).toBe('new');
    expect(g.currentPriceCents).toBe(1399);
  });

  it('a product with neither stats (a non-empty current array) nor csv is an error (no_stats), never no_price', () => {
    expect(parseProductFacts(base({ title: 'T' }), 'B000000001')).toEqual(emptyFacts('B000000001', 'error', 'no_stats'));
    expect(parseProductFacts(base({ title: 'T', stats: { current: [] } }), 'B000000001')).toEqual(emptyFacts('B000000001', 'error', 'no_stats'));
  });

  it('a non-object, an array or a mismatched asin is an error for that ASIN only', () => {
    expect(parseProductFacts(null, 'B000000001')).toEqual(emptyFacts('B000000001', 'error', 'bad_object'));
    expect(parseProductFacts([], 'B000000001')).toEqual(emptyFacts('B000000001', 'error', 'bad_object'));
    expect(parseProductFacts(base({ asin: 'B000000002' }), 'B000000001').errorCode).toBe('asin_mismatch');
  });

  it('Keepa productType 3 (inaccessible) is delisted like 4; a standard product (0) parses normally', () => {
    expect(parseProductFacts(base({ productType: 3, title: 'T' }), 'B000000001')).toEqual(emptyFacts('B000000001', 'delisted'));
    expect(parseProductFacts(base({ productType: 0, stats: { current: [1299] } }), 'B000000001').status).toBe('active');
  });

  it('strips NUL characters from strings and nulls integers beyond the int4 range', () => {
    const current: number[] = []; current[PRICE_TYPE.COUNT_REVIEWS] = 3e9; current[PRICE_TYPE.SALES] = 2_147_483_647;
    const f = parseProductFacts(base({ title: 'Bad\u0000Title', brand: '\u0000', stats: { current } }), 'B000000001');
    expect(f.title).toBe('BadTitle');
    expect(f.brand).toBeNull();
    expect(f.reviewCount).toBeNull();
    expect(f.salesRank).toBe(2_147_483_647);
  });

  it('a category tree with a nameless node has no path, root or leaf at all', () => {
    const tree = [{ name: 'Root' }, { catId: 1 }, { name: 'Leaf' }];
    const f = parseProductFacts(base({ stats: { current: [-1] }, categoryTree: tree }), 'B000000001');
    expect(f.status).toBe('no_price');
    expect([f.categoryPath, f.categoryRoot, f.categoryLeaf]).toEqual([null, null, null]);
  });
});

describe('parseKeepaBatch', () => {
  it('returns one entry per requested ASIN and marks a missing product as an error (missing_from_reply)', () => {
    const out = parseKeepaBatch([TOILET_PAPER, 'B0MISSING00'], products);
    expect(out.size).toBe(2);
    expect(out.get(TOILET_PAPER)?.status).toBe('active');
    expect(out.get('B0MISSING00')).toEqual(emptyFacts('B0MISSING00', 'error', 'missing_from_reply'));
  });
  it('tolerates a non-array products field: every requested ASIN is an error (missing_from_reply)', () => {
    const out = parseKeepaBatch(['B000000001', 'B000000002'], undefined);
    expect([...out.values()]).toEqual([emptyFacts('B000000001', 'error', 'missing_from_reply'), emptyFacts('B000000002', 'error', 'missing_from_reply')]);
  });
  it('a product whose parse throws is an error for that ASIN only (parse_failed)', () => {
    const bad = { asin: 'B000000001', stats: { current: [1299] }, get listedSince() { throw new Error('boom'); } };
    const good = { asin: 'B000000002', title: 'T', stats: { current: [1299] } };
    const out = parseKeepaBatch(['B000000001', 'B000000002'], [bad, good]);
    expect(out.get('B000000001')).toEqual(emptyFacts('B000000001', 'error', 'parse_failed'));
    expect(out.get('B000000002')?.status).toBe('active');
    expect(out.get('B000000002')?.currentPriceCents).toBe(1299);
  });
});

describe('helpers', () => {
  it('keepaMinutesToDate: epoch and non-positive values', () => {
    expect(keepaMinutesToDate(1440)).toBe('2011-01-02');
    expect(keepaMinutesToDate(0)).toBeNull();
    expect(keepaMinutesToDate(-1)).toBeNull();
    expect(keepaMinutesToDate('x')).toBeNull();
  });
  it('keepaMinutesToDate: garbage outside a sane year range is null, never a throw or a 5-digit year', () => {
    expect(keepaMinutesToDate(4.2e9)).toBeNull();
    expect(keepaMinutesToDate(1.5e11)).toBeNull();
    expect(keepaMinutesToDate(Number.POSITIVE_INFINITY)).toBeNull();
  });
  it('primaryImageUrl: medium image of the first entry', () => {
    expect(primaryImageUrl([{ m: 'abc.jpg' }])).toBe('https://m.media-amazon.com/images/I/abc.jpg');
    expect(primaryImageUrl([{ m: 'ab\u0000c.jpg' }])).toBe('https://m.media-amazon.com/images/I/abc.jpg');
    expect(primaryImageUrl([{ m: '\u0000' }])).toBeNull();
    expect(primaryImageUrl([])).toBeNull();
    expect(primaryImageUrl(null)).toBeNull();
  });
});
