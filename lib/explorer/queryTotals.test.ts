import { describe, it, expect } from 'vitest';
import {
  applyCountCap,
  canUseCategoryFacet,
  canUseDefaultTotal,
  canUseLeafCategoryFacet,
  extractCount,
  extractWindowTotal,
} from './queryTotals';
import { COUNT_CAP } from './buildQuery';
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
