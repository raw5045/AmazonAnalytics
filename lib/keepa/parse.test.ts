/**
 * Parser tests against captured Keepa fixtures.
 *
 * Fixtures live in __fixtures__/. Capture procedure: see
 * scripts/keepaSpotCheck.ts (committed) for how we fetch ASINs against
 * Keepa, and the throwaway scripts/_captureKeepaFixtures.ts which was
 * used to seed lib/keepa/__fixtures__/ (deleted after the initial
 * capture — see commit history of this directory).
 */
import { describe, it, expect } from 'vitest';
import {
  parseKeepaProduct,
  keepaMinutesToDate,
  averageCsvLastN,
  primaryImageUrl,
  lastCsvValue,
} from './parse';
import activeFixture from './__fixtures__/active-toiletpaper.json';
import noPriceFixture from './__fixtures__/no-price-needoh.json';

describe('lastCsvValue', () => {
  it('returns null for missing or short arrays', () => {
    expect(lastCsvValue(undefined)).toBe(null);
    expect(lastCsvValue(null)).toBe(null);
    expect(lastCsvValue([])).toBe(null);
    expect(lastCsvValue([12345])).toBe(null);
    expect(lastCsvValue('not-an-array')).toBe(null);
  });
  it('returns the last value', () => {
    expect(lastCsvValue([1, 100, 2, 200, 3, 300])).toBe(300);
  });
  it('returns null when the last value is -1 (unavailable)', () => {
    expect(lastCsvValue([1, 100, 2, -1])).toBe(null);
  });
});

describe('keepaMinutesToDate', () => {
  it('returns null for null / undefined / negative', () => {
    expect(keepaMinutesToDate(null)).toBe(null);
    expect(keepaMinutesToDate(undefined)).toBe(null);
    expect(keepaMinutesToDate(-1)).toBe(null);
  });
  it('km=0 → Keepa epoch 2011-01-01', () => {
    expect(keepaMinutesToDate(0)).toBe('2011-01-01');
  });
  it('1440 minutes after epoch → 2011-01-02', () => {
    expect(keepaMinutesToDate(1440)).toBe('2011-01-02');
  });
  it('handles a recent value (from toilet-paper fixture)', () => {
    // 8083776 is the actual lastRatingUpdate value in our active fixture.
    // It should resolve to mid-May 2026 (when we captured the fixture).
    const r = keepaMinutesToDate(8_083_776);
    expect(r).toMatch(/^2026-05/);
  });
});

describe('primaryImageUrl', () => {
  it('returns null for missing or empty', () => {
    expect(primaryImageUrl(null)).toBe(null);
    expect(primaryImageUrl(undefined)).toBe(null);
    expect(primaryImageUrl([])).toBe(null);
    expect(primaryImageUrl('not-an-array')).toBe(null);
  });
  it('returns null when first entry has no `m` field', () => {
    expect(primaryImageUrl([{}])).toBe(null);
    expect(primaryImageUrl([{ l: 'big.jpg' }])).toBe(null);
    expect(primaryImageUrl([{ m: '' }])).toBe(null);
  });
  it('builds a media-amazon URL from the medium key', () => {
    const r = primaryImageUrl([{ l: 'big.jpg', m: 'med.jpg', mH: 500, mW: 500 }]);
    expect(r).toBe('https://m.media-amazon.com/images/I/med.jpg');
  });
  it('only uses the first image when many are present', () => {
    const r = primaryImageUrl([
      { m: 'first.jpg' },
      { m: 'second.jpg' },
      { m: 'third.jpg' },
    ]);
    expect(r).toBe('https://m.media-amazon.com/images/I/first.jpg');
  });
});

describe('averageCsvLastN', () => {
  it('returns null when fewer than 2 valid points in window', () => {
    expect(averageCsvLastN([100, 500], 30, 1000)).toBe(null);
    expect(averageCsvLastN(null, 30, 1000)).toBe(null);
    expect(averageCsvLastN([], 30, 1000)).toBe(null);
  });
  it('returns the simple mean of values inside the window', () => {
    // window = last 30 days = 43,200 minutes
    // nowMinutes = 1000, so cutoff = 1000 - 43200 = -42200
    // all 3 entries (t=950/980/1000) qualify
    const csv = [950, 100, 980, 200, 1000, 300];
    expect(averageCsvLastN(csv, 30, 1000)).toBe(200);
  });
  it('skips -1 (unavailable) values but still counts the rest', () => {
    // values 100, -1, 300 → mean of [100, 300] = 200
    const csv = [950, 100, 970, -1, 1000, 300];
    expect(averageCsvLastN(csv, 30, 1000)).toBe(200);
  });
  it('rounds to the nearest integer', () => {
    // [100, 101] → 100.5 → 101 (banker's rounding via Math.round)
    const csv = [950, 100, 1000, 101];
    expect(averageCsvLastN(csv, 30, 1000)).toBe(101);
  });
  it('walks back only to the window cutoff', () => {
    // 1 day = 1440 min. nowMinutes=1000, cutoff = -440. So
    // entries at t=900 (within) and t=-1000 (outside) — only the
    // inside-window entries should contribute.
    const csv = [-1000, 999, 900, 100, 950, 200, 1000, 300];
    expect(averageCsvLastN(csv, 1, 1000)).toBe(200); // mean of 100/200/300
  });
});

describe('parseKeepaProduct — active path (B07BGLT25K toilet paper)', () => {
  const row = parseKeepaProduct(
    activeFixture.products[0],
    'B07BGLT25K',
    '2026-05-15',
  );

  it('marks as active when csv[0] has a current price', () => {
    expect(row.enrichment_status).toBe('active');
  });
  it('captures title + brand from product object', () => {
    expect(row.title).toMatch(/Scott/);
    expect(row.brand).toBe('Scott');
  });
  it('builds an image URL from images[0].m', () => {
    expect(row.image_url).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\//);
  });
  it('reads price from csv[0] (cents)', () => {
    // Spot-check 2026-05-15 reported $5.68 → 568 cents
    expect(row.current_price_cents).toBe(568);
  });
  it('reads review count and rating from csv[17] / csv[16]', () => {
    // Spot-check: 138,242 reviews at 4.5★
    expect(row.review_count).toBe(138_242);
    expect(row.average_rating_x10).toBe(45);
  });
  it('builds a 4-level category breadcrumb', () => {
    expect(row.category_path).toMatch(/Health & Household.+Toilet Paper$/);
    expect(row.category_root).toBe('Health & Household');
    expect(row.category_leaf).toBe('Toilet Paper');
  });
  it('captures last_rating_update', () => {
    expect(row.last_rating_update).toMatch(/^2026-05/);
  });
  it('captures variations and promotions arrays', () => {
    expect(Array.isArray(row.variations)).toBe(true);
    expect(Array.isArray(row.promotions)).toBe(true);
  });
  it('computes trailing-window averages from csv[0] history', () => {
    expect(typeof row.avg30_price_cents === 'number').toBe(true);
    expect(typeof row.avg90_price_cents === 'number').toBe(true);
    expect(typeof row.avg365_price_cents === 'number').toBe(true);
  });
});

describe('parseKeepaProduct — no_price path (B0GX1XP72Z)', () => {
  const row = parseKeepaProduct(
    noPriceFixture.products[0],
    'B0GX1XP72Z',
    '2026-05-15',
  );

  it('marks as no_price when both Amazon + New csv ends on -1', () => {
    expect(row.enrichment_status).toBe('no_price');
  });
  it('still captures reviews and rating', () => {
    expect(row.review_count).toBe(9);
    expect(row.average_rating_x10).toBe(36); // 3.6★
  });
  it('still captures an image URL', () => {
    expect(row.image_url).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\//);
  });
  it('current_price_cents is null', () => {
    expect(row.current_price_cents).toBe(null);
  });
  it('handles a null categoryTree gracefully', () => {
    expect(row.category_path).toBe(null);
    expect(row.category_root).toBe(null);
    expect(row.category_leaf).toBe(null);
  });
});

describe('parseKeepaProduct — delisted path', () => {
  it('marks as delisted when product is null', () => {
    const row = parseKeepaProduct(null, 'B0DEADASIN', '2026-05-15');
    expect(row.enrichment_status).toBe('delisted');
    expect(row.title).toBe(null);
    expect(row.current_price_cents).toBe(null);
    expect(row.image_url).toBe(null);
    expect(row.category_path).toBe(null);
  });
  it('marks as delisted when product is undefined', () => {
    const row = parseKeepaProduct(undefined, 'B0DEADASIN', '2026-05-15');
    expect(row.enrichment_status).toBe('delisted');
  });
  it('preserves asin and week_end_date even when delisted', () => {
    const row = parseKeepaProduct(null, 'B0DEADASIN', '2026-05-15');
    expect(row.asin).toBe('B0DEADASIN');
    expect(row.week_end_date).toBe('2026-05-15');
  });
});
