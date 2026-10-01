import { isDeepStrictEqual } from 'node:util';
import { describe, it, expect } from 'vitest';
import { EXPLORER_DEFAULTS, parseExplorerFilters } from '@/lib/explorer/parseFilters';
import { searchParamsToLike } from '@/lib/explorer/export/query';
import { normalizeFilters } from '@/lib/savedViews/validation';
import { filtersSchema, type Filters, type Sort, type Window } from '@/lib/research/contracts';
import {
  compactExplorerFilters, customCategoryUrlFor, explorerUrlFor, savedViewUrlFor, toExplorerFilters,
  NOTE_BASELINE, NOTE_DELTA, NOTE_EXPLORER_REREAD, NOTE_MOVE_UNSUPPORTED, NOTE_PRIOR_BAND, NOTE_PRIOR_ONLY, NOTE_WORD_COUNT_SORT,
} from './explorerFilters';

const APP = 'https://keywordquarry.com';
const CUSTOM_ID = '11111111-1111-4111-8111-111111111111';
const SORT: Sort = { field: 'estimatedMonthlySearches', direction: 'desc' };
const F = (partial: Record<string, unknown> = {}): Filters => filtersSchema.parse(partial);
const convert = (filters: Filters, over: { sort?: Sort; window?: Window; leaves?: string[] } = {}) => {
  const r = toExplorerFilters({ filters, sort: over.sort ?? SORT, window: over.window ?? '4w', leaves: over.leaves ?? [] });
  // The Explorer re-reads every link and view through normalizeFilters; the converter promises exactness unless it says otherwise.
  expect(isDeepStrictEqual(normalizeFilters(r.filters), r.filters)).toBe(!r.notes.includes(NOTE_EXPLORER_REREAD));
  return r;
};

describe('toExplorerFilters', () => {
  it('an empty search is the default Explorer at the search window, with no notes', () => {
    const { filters, notes } = convert(F());
    expect(filters).toEqual({ ...EXPLORER_DEFAULTS, window: '4w' });
    expect(notes).toEqual([]);
  });

  it('copies text, excluded terms, ranges (gt/lt shifted to inclusive), broad category, severities and title gap exactly', () => {
    const { filters, notes } = convert(F({
      text: { value: 'lamp', mode: 'broad' }, excludeTerms: ['floor'],
      rank: { gt: 100, lte: 5000 }, estimatedMonthlySearches: { gte: 1000, lt: 20000 }, averageReviews: { lt: 500 }, wordCount: { gte: 4 },
      broadCategory: 'Home', severities: ['none'], titleGap: { slots: [1, 2], quantifier: 'all', mode: 'strict' },
    }));
    expect(filters).toMatchObject({
      q: 'lamp', qMode: 'broad', qExclude: ['floor'], rankMin: 101, rankMax: 5000, volMin: 1000, volMax: 19999, reviewsMin: null, reviewsMax: 499,
      wordsMin: 4, wordsMax: null, category: 'Home', severities: ['none'], titleSlots: [1, 2], titleMatchMode: 'all', matchMode: 'strict', jump: null,
    });
    expect(notes).toEqual([]);
  });

  it('taxonomy selections become the expanded leaves; custom selections pass by id and are never expanded', () => {
    const { filters } = convert(
      F({ categories: { selections: [{ kind: 'taxonomy', path: 'A › B', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } }),
      { leaves: ['A › B › C', 'A › B › D'] },
    );
    expect(filters.leafPaths).toEqual(['A › B › C', 'A › B › D']);
    expect(filters.customCategoryIds).toEqual([CUSTOM_ID]);
    expect(filters.category).toBeNull();
  });

  it('a department alone expands to its leaves like any other selection (the Explorer\'s broad category is a different taxonomy)', () => {
    const dept = { kind: 'taxonomy' as const, path: 'Lighting', includeDescendants: true };
    const { filters, notes } = convert(F({ categories: { selections: [dept] } }), { leaves: ['Lighting › Ceiling Lights', 'Lighting › Lamps'] });
    expect(filters).toMatchObject({ category: null, leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'] });
    expect(notes).toEqual([]);
  });

  it('"moved from 100k to 50k over the last week" lands on the rank preset, with the baseline note', () => {
    const { filters, notes } = convert(F({ movement: { window: '1w', metric: 'rank', prior: { gt: 100000 }, current: { lt: 50000 } } }), { window: '1w' });
    expect(filters).toMatchObject({ window: '1w', jump: '100k_to_50k', jumpMetric: 'rank', jumpFrom: null, jumpTo: null, rankMin: null, rankMax: null });
    expect(notes).toEqual([NOTE_BASELINE]);
  });

  it('shifts gte/lte onto the Explorer\'s strict from/to and falls back to a custom jump; include_not_observed is exact', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'rank', prior: { gte: 80001 }, current: { lte: 39999 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: 'custom', jumpMetric: 'rank', jumpFrom: 80000, jumpTo: 40000 });
    expect(notes).toEqual([]);
  });

  it('maps a volume move onto the volume presets', () => {
    const { filters } = convert(F({ movement: { window: '4w', metric: 'volume', prior: { lt: 5000 }, current: { gt: 15000 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: 'v5k_to_15k', jumpMetric: 'volume' });
  });

  it('shifts volume lte/gte the other way and keeps the unread current bound as volMax', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'volume', prior: { lte: 4999 }, current: { gte: 15001, lte: 50000 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: 'v5k_to_15k', jumpMetric: 'volume', jumpFrom: null, jumpTo: null, volMin: null, volMax: 50000 });
    expect(notes).toEqual([]);
  });

  it('a current-only bound is the plain range, exactly; a prior-only bound is dropped with a note', () => {
    const currentOnly = convert(F({ movement: { window: '4w', metric: 'rank', current: { lt: 50000 } } }));
    expect(currentOnly.filters).toMatchObject({ jump: null, rankMax: 49999 });
    expect(currentOnly.notes).toEqual([NOTE_BASELINE]);
    const priorOnly = convert(F({ movement: { window: '4w', metric: 'volume', prior: { lt: 5000 }, baseline: 'include_not_observed' } }));
    expect(priorOnly.filters).toMatchObject({ jump: null, volMin: null, volMax: null });
    expect(priorOnly.notes).toEqual([NOTE_PRIOR_ONLY]);
  });

  it('a band on the prior keeps the side the jump uses and notes the other; an extra current bound tightens the plain range', () => {
    // observed_only on purpose: the schema forbids a prior upper bound under include_not_observed for rank.
    // 100000→40000 is deliberately not a preset, so this also exercises the custom-jump path.
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'rank', prior: { gt: 100000, lt: 500000 }, current: { gte: 10000, lt: 40000 } } }));
    expect(filters).toMatchObject({ jump: 'custom', jumpFrom: 100000, jumpTo: 40000, rankMin: 10000, rankMax: null });
    expect(notes).toEqual([NOTE_PRIOR_BAND, NOTE_BASELINE]);
  });

  it('a delta filter is dropped with a note and nothing else changes', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'volume', delta: { gt: 0 } } }));
    expect(filters).toMatchObject({ jump: null, volMin: null, volMax: null });
    expect(notes).toEqual([NOTE_DELTA]);
  });

  it('a move the Explorer would reject is dropped with a note; its current bound still becomes the plain range', () => {
    const { filters, notes } = convert(F({ movement: { window: '4w', metric: 'rank', prior: { gt: 100 }, current: { lt: 200 }, baseline: 'include_not_observed' } }));
    expect(filters).toMatchObject({ jump: null, rankMax: 199 });
    expect(notes).toEqual([NOTE_MOVE_UNSUPPORTED]);
  });

  it('a decline, or a prior bound on the side the jump never reads, is noted as a move the Explorer cannot express; the current bound still becomes the plain range', () => {
    const volumeDecline = convert(F({ movement: { window: '4w', metric: 'volume', prior: { gte: 50000 }, current: { lt: 10000 }, baseline: 'include_not_observed' } }));
    expect(volumeDecline.filters).toMatchObject({ jump: null, volMin: null, volMax: 9999 });
    expect(volumeDecline.notes).toEqual([NOTE_MOVE_UNSUPPORTED]);
    const rankDrop = convert(F({ movement: { window: '4w', metric: 'rank', prior: { lte: 1000 }, current: { gt: 1000 } } }));
    expect(rankDrop.filters).toMatchObject({ jump: null, rankMin: 1001, rankMax: null });
    expect(rankDrop.notes).toEqual([NOTE_MOVE_UNSUPPORTED, NOTE_BASELINE]);
    const priorUnreadOnly = convert(F({ movement: { window: '4w', metric: 'rank', prior: { lte: 1000 } } }));
    expect(priorUnreadOnly.filters).toMatchObject({ jump: null, rankMin: null, rankMax: null });
    expect(priorUnreadOnly.notes).toEqual([NOTE_PRIOR_ONLY]);
  });

  it('maps every sort; word count falls back to rank with a note', () => {
    const sortOf = (sort: Sort) => convert(F(), { sort });
    expect(sortOf({ field: 'estimatedMonthlySearches', direction: 'desc' }).filters.sort).toBe('rank');
    expect(sortOf({ field: 'estimatedMonthlySearches', direction: 'asc' }).filters.sort).toBe('rank_desc');
    expect(sortOf({ field: 'rank', direction: 'asc' }).filters.sort).toBe('rank');
    expect(sortOf({ field: 'rank', direction: 'desc' }).filters.sort).toBe('rank_desc');
    expect(sortOf({ field: 'averageReviews', direction: 'asc' }).filters.sort).toBe('avg_reviews_asc');
    expect(sortOf({ field: 'averageReviews', direction: 'desc' }).filters.sort).toBe('avg_reviews_desc');
    expect(sortOf({ field: 'volumeDelta', direction: 'desc' }).filters.sort).toBe('imp');
    expect(sortOf({ field: 'volumeDelta', direction: 'asc' }).filters.sort).toBe('decline');
    const words = sortOf({ field: 'wordCount', direction: 'asc' });
    expect(words.filters.sort).toBe('rank');
    expect(words.notes).toEqual([NOTE_WORD_COUNT_SORT]);
  });

  it('notes an excluded term the Explorer would read back differently (a comma splits it, a doubled space collapses)', () => {
    const comma = convert(F({ excludeTerms: ['lamp, floor'] }));
    expect(comma.filters.qExclude).toEqual(['lamp, floor']);
    expect(comma.notes).toEqual([NOTE_EXPLORER_REREAD]);
    const spaces = convert(F({ excludeTerms: ['ceiling  fan'] }));
    expect(spaces.notes).toEqual([NOTE_EXPLORER_REREAD]);
    expect(convert(F({ excludeTerms: ['floor', 'ceiling fan'] })).notes).toEqual([]);
  });

  it('keeps severities in canonical order so a reordered default still compacts away', () => {
    const { filters } = convert(F({ severities: ['warning', 'none'] }));
    expect(filters.severities).toEqual(['none', 'warning']);
    expect(compactExplorerFilters(filters)).toEqual({ window: '4w' });
  });

  it('round-trips through the saved-view normaliser and through its own link', () => {
    const { filters } = convert(
      F({ text: { value: 'desk lamp' }, excludeTerms: ['floor', 'ceiling fan'], rank: { lte: 20000 }, averageReviews: { lt: 500 }, severities: ['none', 'warning', 'critical'],
          titleGap: { slots: [1, 2, 3], quantifier: 'any', mode: 'loose' }, movement: { window: '13w', metric: 'volume', prior: { lt: 30000 }, current: { gte: 100001 } },
          categories: { selections: [{ kind: 'taxonomy', path: 'A › B', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } }),
      { window: '13w', sort: { field: 'volumeDelta', direction: 'desc' }, leaves: ['A › B › C'] },
    );
    expect(normalizeFilters(filters)).toEqual({ ...filters, page: 1, perPage: 100 });
    const url = explorerUrlFor(APP, filters)!;
    expect(url.startsWith(`${APP}/explorer?`)).toBe(true);
    expect(parseExplorerFilters(searchParamsToLike(new URL(url).searchParams))).toEqual({ ...filters, page: 1, perPage: 100 });
  });
});

describe('compactExplorerFilters', () => {
  it('keeps only the fields that differ from the defaults, never pagination, and jumpMetric whenever a jump is set', () => {
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS })).toEqual({});
    expect(compactExplorerFilters(convert(F()).filters)).toEqual({ window: '4w' }); // fresh arrays, not the shared defaults
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS, q: 'lamp', page: 3, perPage: 50, jumpMetric: 'volume' })).toEqual({ q: 'lamp' });
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS, jump: 'v5k_to_15k', jumpMetric: 'volume' })).toEqual({ jump: 'v5k_to_15k', jumpMetric: 'volume' });
    expect(compactExplorerFilters({ ...EXPLORER_DEFAULTS, jump: '100k_to_50k' })).toEqual({ jump: '100k_to_50k', jumpMetric: 'rank' });
  });
});

describe('links', () => {
  it('builds the view and category links off APP_PUBLIC_URL without a double slash', () => {
    expect(savedViewUrlFor('https://keywordquarry.com/', 'v1')).toBe('https://keywordquarry.com/explorer?view=v1');
    expect(customCategoryUrlFor(APP, 'c1')).toBe('https://keywordquarry.com/explorer?custom=c1');
  });
  it('omits a search link that would exceed 12,000 bytes', () => {
    const leaves = Array.from({ length: 400 }, (_, i) => `Department › Section ${i} › A fairly long leaf category name ${i}`);
    expect(explorerUrlFor(APP, { ...EXPLORER_DEFAULTS, leafPaths: leaves })).toBeNull();
    expect(explorerUrlFor(APP, { ...EXPLORER_DEFAULTS, leafPaths: leaves.slice(0, 3) })).toContain('leaf=');
  });
});
