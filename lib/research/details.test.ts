import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

import { defaultDetailsDeps, loadKeywordDetails, toProductSlots, type DetailsDeps } from './details';

const header = {
  searchTermId: 'id-1', searchTermRaw: 'hair oil', searchTermNormalized: 'hair oil', firstSeenWeek: '2025-01-04', lastSeenWeek: '2026-09-12',
  current: {
    currentWeekEndDate: '2026-09-12', currentRank: 1234, priorWeekRank: 1300, improvement1w: 66, fakeVolumeSeverityCurrent: null,
    topClickedProduct1AsinCurrent: 'B0A', topClickedProduct1TitleCurrent: 'Oil', topClickedProduct1ClickShareCurrent: '32.50', topClickedProduct1ConversionShareCurrent: '10.00',
    keywordInTitle1LooseCurrent: true, keywordInTitle2LooseCurrent: null, keywordInTitle3LooseCurrent: false, keywordTitleMatchCountLooseCurrent: 1,
    estimatedMonthlyVolumeCurrent: 48000, estimatedMonthlyVolumeIsExtrapolated: false,
  },
};
const products = {
  currentWeekProductSlots: [
    { slot: 1 as const, asin: 'B0A', title: 'Oil', clickShare: '32.50', conversionShare: '10.00' },
    { slot: 2 as const, asin: 'B0B', title: 'Serum', clickShare: null, conversionShare: null },
    { slot: 3 as const, asin: null, title: null, clickShare: null, conversionShare: null },
  ],
  enrichedProductsByAsin: {
    B0A: { asin: 'B0A', title: 'Oil', brand: null, imageUrl: null, categoryPath: null, categoryRoot: null, categoryLeaf: null, currentPriceCents: 1999, salesRank: 500, reviewCount: 4321, averageRatingX10: 45, avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null, enrichmentStatus: 'active' as const },
  },
};
/** All three slots ASIN'd and enriched with a review count — for the negative PARTIAL_REVIEW_COVERAGE_POSSIBLE test. */
const fullyReviewedProducts = {
  currentWeekProductSlots: [
    { slot: 1 as const, asin: 'B0A', title: 'Oil', clickShare: '32.50', conversionShare: '10.00' },
    { slot: 2 as const, asin: 'B0B', title: 'Serum', clickShare: '20.00', conversionShare: '5.00' },
    { slot: 3 as const, asin: 'B0C', title: 'Balm', clickShare: '10.00', conversionShare: '2.00' },
  ],
  enrichedProductsByAsin: {
    B0A: products.enrichedProductsByAsin.B0A,
    B0B: { ...products.enrichedProductsByAsin.B0A, asin: 'B0B', reviewCount: 222 },
    B0C: { ...products.enrichedProductsByAsin.B0A, asin: 'B0C', reviewCount: 333 },
  },
};
const summary = { estimated_monthly_volume_current: '48210', avg_reviews: 312, word_count: 2, top_clicked_category_path: 'Beauty › Hair Care', top_clicked_category_1_current: 'Beauty', fake_volume_severity_current: null };
const meta = { currentWeekEndDate: '2026-09-12', snapshotVersion: 'snap-a', refreshedAt: 'x', volumeFitRunId: null, calibrationMonthEndDate: null, isExtrapolated: false };
const deps = (over: Partial<DetailsDeps> = {}): DetailsDeps => ({ appUrl: 'https://keywordquarry.com', header: async () => header, products: async () => products, summary: async () => summary, meta: async () => meta, ...over });

describe('loadKeywordDetails', () => {
  it('combines header, stored summary and enriched products; ratings are stars; missing stays null', async () => {
    const out = await loadKeywordDetails('id-1', deps());
    expect(out).toMatchObject({ status: 'active', keyword: 'hair oil', keywordUrl: 'https://keywordquarry.com/explorer/keyword/id-1', provenance: { datasetWeek: '2026-09-12', snapshotVersion: 'snap-a' } });
    expect(out.current).toEqual({ datasetWeek: '2026-09-12', rank: 1234, priorWeekRank: 1300, estimatedMonthlySearches: 48210, volumeIsExtrapolated: false, averageReviews: 312, wordCount: 2, categoryPath: 'Beauty › Hair Care', broadCategory: 'Beauty', severity: null, titleFlagsLoose: [true, null, false] });
    expect(toProductSlots(products)[0]).toEqual({ slot: 1, asin: 'B0A', title: 'Oil', clickSharePct: 32.5, conversionSharePct: 10, reviewCount: 4321, ratingStars: 4.5, currentPriceCents: 1999, salesRank: 500, enrichmentStatus: 'active' });
    expect(toProductSlots(products)[1].reviewCount).toBeNull();
    expect(out.warnings.map((w) => w.code)).toEqual(['ESTIMATED_VOLUME', 'PARTIAL_REVIEW_COVERAGE_POSSIBLE']);
  });

  it('a dormant keyword returns identity with current=null and no product lookup (Q30); an unknown id is KEYWORD_NOT_FOUND', async () => {
    let productsCalled = false;
    const out = await loadKeywordDetails('id-1', deps({ header: async () => ({ ...header, current: null }), summary: async () => null, products: async () => { productsCalled = true; return products; } }));
    expect(out.status).toBe('dormant');
    expect(out.current).toBeNull();
    expect(out.products).toEqual([]);
    expect(productsCalled).toBe(false);
    expect(out.warnings.map((w) => w.code)).toContain('DORMANT');
    await expect(loadKeywordDetails('x', deps({ header: async () => null }))).rejects.toMatchObject({ code: 'KEYWORD_NOT_FOUND' });
  });

  it('a dormant keyword ignores a non-null summary row — current stays null and status stays dormant regardless', async () => {
    const out = await loadKeywordDetails('id-1', deps({ header: async () => ({ ...header, current: null }), summary: async () => summary }));
    expect(out.status).toBe('dormant');
    expect(out.current).toBeNull();
    expect(out.products).toEqual([]);
  });

  it('refuses without meta (kill switch): DATA_UNAVAILABLE, and the products loader is never called', async () => {
    let productsCalled = false;
    await expect(
      loadKeywordDetails('id-1', deps({ meta: async () => null, products: async () => { productsCalled = true; return products; } })),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    expect(productsCalled).toBe(false);
  });

  it("pairs volumeIsExtrapolated with the STORED volume's fit (meta.isExtrapolated), not the header's current-week flag, and warns EXTRAPOLATED_VOLUME when true", async () => {
    const out = await loadKeywordDetails('id-1', deps({ meta: async () => ({ ...meta, isExtrapolated: true }) }));
    expect(out.current?.estimatedMonthlySearches).toBe(48210); // still the stored summary value
    expect(out.current?.volumeIsExtrapolated).toBe(true); // meta's flag — header.current.estimatedMonthlyVolumeIsExtrapolated is false
    expect(out.warnings.map((w) => w.code)).toContain('EXTRAPOLATED_VOLUME');
  });

  it('falls back to the header current volume and ITS OWN extrapolation flag when no stored summary volume exists; meta.isExtrapolated is not consulted', async () => {
    const out = await loadKeywordDetails('id-1', deps({
      summary: async () => ({ ...summary, estimated_monthly_volume_current: null }),
      meta: async () => ({ ...meta, isExtrapolated: true }),
    }));
    expect(out.current?.estimatedMonthlySearches).toBe(header.current.estimatedMonthlyVolumeCurrent);
    expect(out.current?.volumeIsExtrapolated).toBe(header.current.estimatedMonthlyVolumeIsExtrapolated);
    expect(out.warnings.map((w) => w.code)).not.toContain('EXTRAPOLATED_VOLUME');
  });

  it('does not warn about partial review coverage when all three product slots carry a current-week review count', async () => {
    const out = await loadKeywordDetails('id-1', deps({ products: async () => fullyReviewedProducts }));
    expect(out.warnings.map((w) => w.code)).not.toContain('PARTIAL_REVIEW_COVERAGE_POSSIBLE');
  });
});

describe('defaultDetailsDeps', () => {
  it('has the five keys, with the four loaders as functions', () => {
    const d = defaultDetailsDeps('https://x/');
    expect(Object.keys(d).sort()).toEqual(['appUrl', 'header', 'meta', 'products', 'summary']);
    expect(d.appUrl).toBe('https://x/');
    expect(typeof d.header).toBe('function');
    expect(typeof d.products).toBe('function');
    expect(typeof d.summary).toBe('function');
    expect(typeof d.meta).toBe('function');
  });
});
