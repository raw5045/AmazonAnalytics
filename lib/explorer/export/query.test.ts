import { describe, it, expect } from 'vitest';
import { searchParamsToLike, filtersToQueryString } from './query';
import { parseExplorerFilters } from '../parseFilters';
import type { ExplorerFilters } from '../types';

describe('searchParamsToLike', () => {
  it('maps single values to strings and repeated keys to arrays', () => {
    const like = searchParamsToLike(new URLSearchParams('q=zinc&leaf=A&leaf=B&rank_max=100'));
    expect(like).toEqual({ q: 'zinc', leaf: ['A', 'B'], rank_max: '100' });
  });

  it('returns an empty object for no params', () => {
    expect(searchParamsToLike(new URLSearchParams(''))).toEqual({});
  });
});

describe('filtersToQueryString', () => {
  const filters: ExplorerFilters = {
    window: '4w',
    q: 'magnesium',
    qMode: 'broad',
    rankMin: 10,
    rankMax: 5000,
    reviewsMin: null,
    reviewsMax: 500,
    wordsMin: 2,
    wordsMax: null,
    jump: '100k_to_50k',
    jumpMetric: 'rank',
    jumpFrom: null,
    jumpTo: null,
    category: 'Health_and_Personal_Care',
    leafPaths: ['Health & Household › Magnesium', 'Beauty › Face Moisturizers'],
    customCategoryIds: ['11111111-1111-1111-1111-111111111111'],
    severities: ['none', 'warning'],
    titleSlots: [1, 2],
    titleMatchMode: 'any',
    matchMode: 'loose',
    sort: 'imp',
    page: 1,
    perPage: 100,
  };

  it('round-trips the effective filters through the URL parser with pagination reset', () => {
    const qs = filtersToQueryString({ ...filters, page: 7, perPage: 50 });
    const reparsed = parseExplorerFilters(searchParamsToLike(new URLSearchParams(qs)));
    expect(reparsed).toEqual(filters);
  });

  it('round-trips a custom volume jump and a category-only filter set', () => {
    const custom: ExplorerFilters = {
      ...filters,
      q: null,
      qMode: 'word',
      jump: 'custom',
      jumpMetric: 'volume',
      jumpFrom: 30_000,
      jumpTo: 100_000,
      leafPaths: [],
      customCategoryIds: [],
    };
    expect(parseExplorerFilters(searchParamsToLike(new URLSearchParams(filtersToQueryString(custom))))).toEqual(custom);
    const categoryOnly = parseExplorerFilters({ category: 'Beauty' });
    expect(
      parseExplorerFilters(searchParamsToLike(new URLSearchParams(filtersToQueryString(categoryOnly)))),
    ).toEqual(categoryOnly);
  });

  it('produces no pagination keys', () => {
    const qs = filtersToQueryString({ ...filters, page: 7, perPage: 50 });
    const params = new URLSearchParams(qs);
    expect(params.has('page')).toBe(false);
    expect(params.has('per_page')).toBe(false);
  });
});
