// lib/keepa/parseProduct.test.ts
/**
 * Parser tests against lib/keepa/__fixtures__/batch-stats.json — captured on 2026-10 with the
 * service's exact request (rating=1, stats=90, history=0). Live values drift, so the fixture
 * assertions are structural (status, non-null, ranges); stable facts (category path,
 * listed-since) are asserted exactly.
 */
import { describe, it, expect } from 'vitest';
import { parseProductFacts, parseKeepaBatch, keepaMinutesToDate, primaryImageUrl, PRICE_TYPE } from './parseProduct';
import { emptyFacts } from './productFacts';
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

  it('reads the last csv value when the reply carried history instead of stats', () => {
    const csv: unknown[] = []; csv[PRICE_TYPE.AMAZON] = [100, 1299, 200, 1399]; csv[PRICE_TYPE.COUNT_NEW_FBA] = [100, 3];
    const f = parseProductFacts(base({ csv }), 'B000000001');
    expect(f.currentPriceCents).toBe(1399);
    expect(f.fbaOfferCount).toBe(3);
  });

  it('a non-object or a mismatched asin is an error for that ASIN only', () => {
    expect(parseProductFacts(null, 'B000000001')).toEqual(emptyFacts('B000000001', 'error', 'bad_object'));
    expect(parseProductFacts(base({ asin: 'B000000002' }), 'B000000001').errorCode).toBe('asin_mismatch');
  });

  it('Keepa productType 3 (inaccessible) is delisted like 4; a standard product (0) parses normally', () => {
    expect(parseProductFacts(base({ productType: 3, title: 'T' }), 'B000000001')).toEqual(emptyFacts('B000000001', 'delisted'));
    expect(parseProductFacts(base({ productType: 0, stats: { current: [1299] } }), 'B000000001').status).toBe('active');
  });
});

describe('parseKeepaBatch', () => {
  it('returns one entry per requested ASIN and marks a missing product delisted', () => {
    const out = parseKeepaBatch([TOILET_PAPER, 'B0MISSING00'], products);
    expect(out.size).toBe(2);
    expect(out.get(TOILET_PAPER)?.status).toBe('active');
    expect(out.get('B0MISSING00')).toEqual(emptyFacts('B0MISSING00', 'delisted'));
  });
  it('tolerates a non-array products field', () => {
    expect(parseKeepaBatch(['B000000001'], undefined).get('B000000001')?.status).toBe('delisted');
  });
  it('a product whose parse throws is an error for that ASIN only', () => {
    const bad = { asin: 'B000000001', get listedSince() { throw new Error('boom'); } };
    const good = { asin: 'B000000002', title: 'T', stats: { current: [1299] } };
    const out = parseKeepaBatch(['B000000001', 'B000000002'], [bad, good]);
    expect(out.get('B000000001')).toEqual(emptyFacts('B000000001', 'error', 'bad_object'));
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
    expect(primaryImageUrl([])).toBeNull();
    expect(primaryImageUrl(null)).toBeNull();
  });
});
