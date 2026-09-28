import { describe, it, expect } from 'vitest';
import {
  applyCountCap,
  canUseCategoryFacet,
  canUseDefaultTotal,
  canUseLeafCategoryFacet,
  extractCount,
  extractWindowTotal,
} from './queryTotals';
import { buildExplorerQuery, COUNT_CAP } from './buildQuery';
import { EXPLORER_DEFAULTS } from './parseFilters';
import type { ExplorerFilters } from './types';

const baseFilters: ExplorerFilters = { ...EXPLORER_DEFAULTS };

describe('applyCountCap', () => {
  it('passes through values at or below the cap', () => {
    expect(applyCountCap(0)).toEqual({ total: 0, totalIsCapped: false });
    expect(applyCountCap(COUNT_CAP)).toEqual({ total: COUNT_CAP, totalIsCapped: false });
  });
  it('caps values above the cap and flags it', () => {
    expect(applyCountCap(COUNT_CAP + 1)).toEqual({ total: COUNT_CAP, totalIsCapped: true });
    expect(applyCountCap(999_999)).toEqual({ total: COUNT_CAP, totalIsCapped: true });
  });
});

describe('extractCount', () => {
  it('reads total from the first row (number or bigint-string)', () => {
    expect(extractCount([{ total: 42 }])).toBe(42);
    expect(extractCount([{ total: '42' }])).toBe(42);
  });
  it('returns 0 for an empty result', () => {
    expect(extractCount([])).toBe(0);
  });
});

describe('extractWindowTotal', () => {
  it('returns the total from the first row', () => {
    expect(extractWindowTotal([{ total: 7 }, { total: 7 }])).toBe(7);
    expect(extractWindowTotal([{ total: '7' }])).toBe(7);
  });
  it('returns null for an empty page (no row carries the total)', () => {
    expect(extractWindowTotal([])).toBeNull();
  });
  it('returns null when a row is present but carries no usable total', () => {
    // The guard that distinguishes this from extractCount: a row exists but
    // its `total` is absent → signal the caller to run the fallback count.
    expect(extractWindowTotal([{}])).toBeNull();
  });
});

describe('count short-circuit guards under volume-delta sorts', () => {
  // Otherwise-qualifying filter shape for each guard; only `sort` varies.
  const defaultLanding: ExplorerFilters = { ...baseFilters };
  const categoryOnly: ExplorerFilters = { ...baseFilters, category: 'Beauty' };
  const leafOnly: ExplorerFilters = { ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'] };

  it('canUseDefaultTotal stands down under imp/decline, holds under rank', () => {
    expect(canUseDefaultTotal({ ...defaultLanding, sort: 'imp' })).toBe(false);
    expect(canUseDefaultTotal({ ...defaultLanding, sort: 'decline' })).toBe(false);
    expect(canUseDefaultTotal({ ...defaultLanding, sort: 'rank' })).toBe(true);
  });

  it('canUseCategoryFacet stands down under imp/decline, holds under rank', () => {
    expect(canUseCategoryFacet({ ...categoryOnly, sort: 'imp' })).toBe(false);
    expect(canUseCategoryFacet({ ...categoryOnly, sort: 'decline' })).toBe(false);
    expect(canUseCategoryFacet({ ...categoryOnly, sort: 'rank' })).toBe(true);
  });

  it('canUseLeafCategoryFacet stands down under imp/decline, holds under rank', () => {
    expect(canUseLeafCategoryFacet({ ...leafOnly, sort: 'imp' })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...leafOnly, sort: 'decline' })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...leafOnly, sort: 'rank' })).toBe(true);
  });
});

describe('avg-reviews filter blocks precomputed totals', () => {
  it('canUseDefaultTotal is false when either reviews bound is set', () => {
    expect(canUseDefaultTotal({ ...baseFilters, reviewsMin: 100 })).toBe(false);
    expect(canUseDefaultTotal({ ...baseFilters, reviewsMax: 0 })).toBe(false);
  });

  it('canUseCategoryFacet is false when either reviews bound is set', () => {
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', reviewsMax: 500 })).toBe(false);
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', reviewsMin: 1 })).toBe(false);
  });

  it('canUseLeafCategoryFacet is false when either reviews bound is set', () => {
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], reviewsMin: 1 })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], reviewsMax: 500 })).toBe(false);
  });
});

describe('word-count filter blocks precomputed totals', () => {
  it('canUseDefaultTotal is false when either word bound is set', () => {
    expect(canUseDefaultTotal({ ...baseFilters, wordsMin: 3 })).toBe(false);
    expect(canUseDefaultTotal({ ...baseFilters, wordsMax: 1 })).toBe(false);
  });

  it('canUseCategoryFacet is false when either word bound is set', () => {
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', wordsMin: 3 })).toBe(false);
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', wordsMax: 2 })).toBe(false);
  });

  it('canUseLeafCategoryFacet is false when either word bound is set', () => {
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], wordsMin: 3 })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], wordsMax: 2 })).toBe(false);
  });
});

describe('search-volume range guards', () => {
  it('any volume bound disables every precomputed-total shortcut', () => {
    expect(canUseDefaultTotal({ ...baseFilters, volMin: 10_000 })).toBe(false);
    expect(canUseDefaultTotal({ ...baseFilters, volMax: 0 })).toBe(false);
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', volMin: 10_000 })).toBe(false);
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', volMax: 0 })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], volMin: 10_000 })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], volMax: 0 })).toBe(false);
  });
});

describe('count short-circuit guards under the null-key-excluding avg sorts', () => {
  // Sorting by avg price / avg reviews pushes `kcs.<col> IS NOT NULL` into the WHERE
  // (lib/explorer/buildQuery.ts sortNullKeyColumn), so every precomputed total overcounts.
  const defaultLanding: ExplorerFilters = { ...baseFilters };
  const categoryOnly: ExplorerFilters = { ...baseFilters, category: 'Beauty' };
  const leafOnly: ExplorerFilters = { ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'] };
  const AVG_SORTS = ['avg_reviews_desc', 'avg_reviews_asc', 'avg_price_desc', 'avg_price_asc'] as const;

  it.each(AVG_SORTS)('canUseDefaultTotal stands down under %s', (sort) => {
    expect(canUseDefaultTotal({ ...defaultLanding, sort })).toBe(false);
  });

  it.each(AVG_SORTS)('canUseCategoryFacet stands down under %s', (sort) => {
    expect(canUseCategoryFacet({ ...categoryOnly, sort })).toBe(false);
  });

  it.each(AVG_SORTS)('canUseLeafCategoryFacet stands down under %s', (sort) => {
    expect(canUseLeafCategoryFacet({ ...leafOnly, sort })).toBe(false);
  });
});

describe('exclude terms bypass every precomputed total', () => {
  it('default landing', () => {
    expect(canUseDefaultTotal({ ...EXPLORER_DEFAULTS, qExclude: [] })).toBe(true);
    expect(canUseDefaultTotal({ ...EXPLORER_DEFAULTS, qExclude: ['floor'] })).toBe(false);
  });
  it('broad-category facet', () => {
    expect(canUseCategoryFacet({ ...EXPLORER_DEFAULTS, category: 'Beauty' })).toBe(true);
    expect(canUseCategoryFacet({ ...EXPLORER_DEFAULTS, category: 'Beauty', qExclude: ['floor'] })).toBe(false);
  });
  it('single leaf facet', () => {
    expect(canUseLeafCategoryFacet({ ...EXPLORER_DEFAULTS, leafPaths: ['A › B'] })).toBe(true);
    expect(canUseLeafCategoryFacet({ ...EXPLORER_DEFAULTS, leafPaths: ['A › B'], qExclude: ['floor'] })).toBe(false);
  });
});

describe('guard drift: any filter that changes the count SQL must also disable the precomputed default total', () => {
  const WEEK = '2026-09-19';
  const baseCountSql = buildExplorerQuery(EXPLORER_DEFAULTS, WEEK).countSql;
  const perturbations: Array<[keyof ExplorerFilters, Partial<ExplorerFilters>]> = [
    ['q', { q: 'lamp' }],
    ['qMode', { qMode: 'broad' }],
    ['qExclude', { qExclude: ['floor'] }],
    ['rankMin', { rankMin: 10 }],
    ['rankMax', { rankMax: 1000 }],
    ['volMin', { volMin: 100 }],
    ['volMax', { volMax: 5000 }],
    ['reviewsMin', { reviewsMin: 10 }],
    ['reviewsMax', { reviewsMax: 500 }],
    ['wordsMin', { wordsMin: 2 }],
    ['wordsMax', { wordsMax: 4 }],
    ['jump', { jump: '500k_to_100k' }],
    ['jumpMetric', { jumpMetric: 'volume' }],
    ['jumpFrom', { jumpFrom: 1 }],
    ['jumpTo', { jumpTo: 2 }],
    ['category', { category: 'Beauty' }],
    ['leafPaths', { leafPaths: ['A › B'] }],
    ['customCategoryIds', { customCategoryIds: ['11111111-1111-1111-1111-111111111111'] }],
    ['severities', { severities: ['critical'] }],
    ['titleSlots', { titleSlots: [1] }],
    ['titleMatchMode', { titleMatchMode: 'any' }],
    ['matchMode', { matchMode: 'strict' }],
    ['sort', { sort: 'avg_price_desc' }],
    ['window', { window: '4w' }],
    ['page', { page: 2 }],
    ['perPage', { perPage: 50 }],
  ];
  it.each(perturbations)('%s', (_field, patch) => {
    const f: ExplorerFilters = { ...EXPLORER_DEFAULTS, ...patch };
    const countChanged = buildExplorerQuery(f, WEEK).countSql !== baseCountSql;
    expect(canUseDefaultTotal(f)).toBe(!countChanged);
  });
});
