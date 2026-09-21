import { describe, it, expect } from 'vitest';
import { parseSearchInput, resolveCategoriesInputSchema, keywordHistoryInputSchema, keywordDetailsInputSchema } from './contracts';
import { ResearchError } from './errors';

const base = { schemaVersion: 1 as const };
const fails = (input: unknown, path: string) => {
  try {
    parseSearchInput(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ResearchError);
    const err = e as ResearchError;
    expect(err.code).toBe('INVALID_FILTERS');
    expect(JSON.stringify(err.details)).toContain(path);
    return;
  }
  throw new Error(`expected rejection at ${path}`);
};

describe('parseSearchInput', () => {
  it('fills documented defaults for an otherwise empty new search', () => {
    const out = parseSearchInput(base);
    expect(out.kind).toBe('new');
    if (out.kind !== 'new') return;
    expect(out.request.pageSize).toBe(50);
    expect(out.request.sort).toEqual({ field: 'estimatedMonthlySearches', direction: 'desc' });
    expect(out.request.filters.severities).toEqual(['none', 'warning']);
    expect(out.request.filters.categories).toEqual({ selections: [], leafPaths: [] });
    expect(out.request.filters.estimatedMonthlySearches).toBeNull();
    expect(out.request.presetIds).toEqual([]);
  });

  it('keeps comparators as given (gt stays gt)', () => {
    const out = parseSearchInput({ ...base, filters: { estimatedMonthlySearches: { gt: 10000 }, averageReviews: { lt: 500 } } });
    if (out.kind !== 'new') throw new Error();
    expect(out.request.filters.estimatedMonthlySearches).toEqual({ gt: 10000 });
    expect(out.request.filters.averageReviews).toEqual({ lt: 500 });
  });

  it('rejects unknown keys, wrong schema versions, and a cursor mixed with filters', () => {
    fails({ ...base, filters: { volume: { gt: 1 } } }, 'volume');
    fails({ schemaVersion: 2 }, 'schemaVersion');
    fails({ cursor: 'abc'.repeat(10), pageSize: 10 }, 'cursor');
  });

  it('rejects malformed ranges: empty, two lower bounds, inverted, no legal integer, non-integers, unsafe, negative where forbidden', () => {
    fails({ ...base, filters: { rank: {} } }, 'rank');
    fails({ ...base, filters: { rank: { gt: 1, gte: 2 } } }, 'rank');
    fails({ ...base, filters: { rank: { gte: 10, lte: 5 } } }, 'rank');
    fails({ ...base, filters: { rank: { gt: 5, lt: 6 } } }, 'rank');
    fails({ ...base, filters: { averageReviews: { lt: 1.5 } } }, 'averageReviews');
    fails({ ...base, filters: { averageReviews: { lt: '500' } } }, 'averageReviews');
    fails({ ...base, filters: { estimatedMonthlySearches: { gte: Number.MAX_SAFE_INTEGER + 2 } } }, 'estimatedMonthlySearches');
    fails({ ...base, filters: { rank: { gte: 0 } } }, 'rank');
    fails({ ...base, filters: { averageReviews: { gte: -1 } } }, 'averageReviews');
  });

  it('accepts zero for reviews and searches, and a negative delta', () => {
    const out = parseSearchInput({ ...base, filters: { averageReviews: { lte: 0 }, movement: { window: '4w', metric: 'volume', delta: { lt: -100 } } } });
    expect(out.kind).toBe('new');
  });

  it('rejects short text, an explicit empty severities array, duplicate slots, and a rank-metric delta', () => {
    fails({ ...base, filters: { text: { value: 'ab' } } }, 'text');
    fails({ ...base, filters: { severities: [] } }, 'severities');
    fails({ ...base, filters: { titleGap: { slots: [1, 1] } } }, 'titleGap');
    fails({ ...base, filters: { movement: { window: '4w', metric: 'rank', delta: { gt: 0 } } } }, 'movement');
    fails({ ...base, filters: { movement: { window: '4w', metric: 'volume' } } }, 'movement');
  });

  it('rejects the include_not_observed rank shape without a prior lower bound and a current upper bound', () => {
    fails({ ...base, filters: { movement: { window: '4w', metric: 'rank', baseline: 'include_not_observed', current: { lt: 100 } } } }, 'movement');
    const ok = parseSearchInput({ ...base, filters: { movement: { window: '4w', metric: 'rank', baseline: 'include_not_observed', prior: { gt: 100000 }, current: { lt: 10000 } } } });
    expect(ok.kind).toBe('new');
  });

  it('rejects a comparisonWindow that disagrees with movement.window, and firstSeenWeek sorts', () => {
    fails({ ...base, comparisonWindow: '13w', filters: { movement: { window: '4w', metric: 'volume', delta: { gt: 0 } } } }, 'comparisonWindow');
    fails({ ...base, sort: { field: 'firstSeenWeek', direction: 'asc' } }, 'sort');
  });

  it('caps pageSize at 100 and selections at 25', () => {
    fails({ ...base, pageSize: 101 }, 'pageSize');
    const sel = Array.from({ length: 26 }, (_, i) => ({ kind: 'taxonomy', path: `P${i}`, includeDescendants: true }));
    fails({ ...base, filters: { categories: { selections: sel } } }, 'selections');
  });

  it('returns a continuation for a bare cursor', () => {
    expect(parseSearchInput({ cursor: 'x'.repeat(40) })).toEqual({ kind: 'continuation', cursor: 'x'.repeat(40) });
  });
});

describe('other tool inputs', () => {
  it('resolve_categories: defaults, limits, and when an empty query is allowed', () => {
    expect(resolveCategoriesInputSchema.parse({ query: 'lighting' })).toEqual({ query: 'lighting', source: 'all', parentPath: null, limit: 20, cursor: null });
    expect(resolveCategoriesInputSchema.safeParse({ query: 'x', limit: 51 }).success).toBe(false);
    expect(resolveCategoriesInputSchema.safeParse({ query: '', source: 'taxonomy' }).success).toBe(false);
    expect(resolveCategoriesInputSchema.safeParse({ query: '', source: 'custom' }).success).toBe(true);
    expect(resolveCategoriesInputSchema.safeParse({ query: '', parentPath: 'Home & Kitchen' }).success).toBe(true);
  });
  it('details and history: uuid and week bounds', () => {
    expect(keywordDetailsInputSchema.safeParse({ searchTermId: 'nope' }).success).toBe(false);
    expect(keywordHistoryInputSchema.parse({ searchTermId: '11111111-1111-4111-8111-111111111111' }).weeks).toBe(13);
    expect(keywordHistoryInputSchema.safeParse({ searchTermId: '11111111-1111-4111-8111-111111111111', weeks: 53 }).success).toBe(false);
  });
});
