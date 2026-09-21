import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

import { loadKeywordDetails, toProductSlots, type DetailsDeps } from './details';

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
});
