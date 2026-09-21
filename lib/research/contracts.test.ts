import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  parseSearchInput,
  resolveCategoriesInputSchema,
  keywordHistoryInputSchema,
  keywordDetailsInputSchema,
  searchToolInputSchema,
  emptyInputSchema,
  type SearchRequest,
  type Window,
} from './contracts';
import { ResearchError } from './errors';

const base = { schemaVersion: 1 as const };
const fails = (input: unknown, path: string) => {
  try {
    parseSearchInput(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ResearchError);
    const err = e as ResearchError;
    expect(err.code).toBe('INVALID_FILTERS');
    expect(err.details!.some((d) => d.path === path)).toBe(true);
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
    // sort is optional, not defaulted, in the schema: presence = explicitness. An absent
    // sort key means the catalog (lib/research/catalog.ts) must supply DEFAULT_SORT itself.
    expect(out.request.sort).toBeUndefined();
    expect(out.request.filters.severities).toEqual(['none', 'warning']);
    expect(out.request.filters.categories).toEqual({ selections: [], leafPaths: [] });
    expect(out.request.filters.estimatedMonthlySearches).toBeNull();
    expect(out.request.presetIds).toEqual([]);
  });

  it('gives each parse its own categories arrays, not a shared default', () => {
    const a = parseSearchInput(base);
    const b = parseSearchInput(base);
    if (a.kind !== 'new' || b.kind !== 'new') throw new Error();
    expect(a.request.filters.categories.leafPaths).not.toBe(b.request.filters.categories.leafPaths);
    expect(a.request.filters.categories.selections).not.toBe(b.request.filters.categories.selections);
    a.request.filters.categories.leafPaths.push('A > B');
    a.request.filters.categories.selections.push({ kind: 'taxonomy', path: 'A', includeDescendants: true });
    expect(b.request.filters.categories.leafPaths).toEqual([]);
    expect(b.request.filters.categories.selections).toEqual([]);
  });

  it('keeps comparators as given (gt stays gt)', () => {
    const out = parseSearchInput({ ...base, filters: { estimatedMonthlySearches: { gt: 10000 }, averageReviews: { lt: 500 } } });
    if (out.kind !== 'new') throw new Error();
    expect(out.request.filters.estimatedMonthlySearches).toEqual({ gt: 10000 });
    expect(out.request.filters.averageReviews).toEqual({ lt: 500 });
  });

  it('rejects an unknown top-level key, wrong schema versions, and a cursor mixed with filters', () => {
    try {
      parseSearchInput({ ...base, volume: { gt: 1 } });
      throw new Error('expected rejection at (root)');
    } catch (e) {
      expect(e).toBeInstanceOf(ResearchError);
      const err = e as ResearchError;
      expect(err.code).toBe('INVALID_FILTERS');
      expect(err.details!.some((d) => d.path === '(root)')).toBe(true);
      expect(err.message).toContain('volume');
    }
    fails({ schemaVersion: 2 }, 'schemaVersion');
    fails({ cursor: 'abc'.repeat(10), pageSize: 10 }, 'cursor');
  });

  it('rejects malformed ranges: empty, two lower bounds, inverted, non-integers, unsafe, below the domain floor, and empty because of the domain floor', () => {
    fails({ ...base, filters: { rank: {} } }, 'filters.rank');
    fails({ ...base, filters: { rank: { gt: 1, gte: 2 } } }, 'filters.rank');
    fails({ ...base, filters: { rank: { gte: 10, lte: 5 } } }, 'filters.rank');
    fails({ ...base, filters: { rank: { gt: 5, lt: 6 } } }, 'filters.rank');
    fails({ ...base, filters: { averageReviews: { lt: 1.5 } } }, 'filters.averageReviews.lt');
    fails({ ...base, filters: { averageReviews: { lt: '500' } } }, 'filters.averageReviews.lt');
    fails({ ...base, filters: { estimatedMonthlySearches: { gte: Number.MAX_SAFE_INTEGER + 2 } } }, 'filters.estimatedMonthlySearches.gte');
    fails({ ...base, filters: { rank: { gte: 0 } } }, 'filters.rank.gte');
    fails({ ...base, filters: { averageReviews: { gte: -1 } } }, 'filters.averageReviews.gte');
    // Empty at the domain floor: no explicit lower bound is given, but the domain floor
    // seeds one implicitly, and that leaves no room below the given upper bound.
    fails({ ...base, filters: { rank: { lt: 1 } } }, 'filters.rank');
    fails({ ...base, filters: { wordCount: { lt: 1 } } }, 'filters.wordCount');
    fails({ ...base, filters: { averageReviews: { lt: 0 } } }, 'filters.averageReviews');
    fails({ ...base, filters: { estimatedMonthlySearches: { lt: 0 } } }, 'filters.estimatedMonthlySearches');
  });

  it('caps rank/averageReviews bounds at the int4 column ceiling and wordCount at the int2 ceiling (I3); estimatedMonthlySearches (bigint) stays uncapped', () => {
    fails({ ...base, filters: { rank: { lte: 2_147_483_648 } } }, 'filters.rank.lte');
    expect(parseSearchInput({ ...base, filters: { rank: { lte: 2_147_483_647 } } }).kind).toBe('new');
    fails({ ...base, filters: { averageReviews: { lte: 2_147_483_648 } } }, 'filters.averageReviews.lte');
    fails({ ...base, filters: { wordCount: { gte: 32_768 } } }, 'filters.wordCount.gte');
    const bigVolume = parseSearchInput({ ...base, filters: { estimatedMonthlySearches: { gte: 3_000_000_000 } } });
    expect(bigVolume.kind).toBe('new');
  });

  it('accepts zero for reviews and searches, an at-the-floor lte, and a negative delta', () => {
    const out = parseSearchInput({
      ...base,
      filters: { averageReviews: { lte: 0 }, movement: { window: '4w', metric: 'volume', delta: { lt: -100 } } },
    });
    expect(out.kind).toBe('new');
    expect(parseSearchInput({ ...base, filters: { rank: { lte: 1 } } }).kind).toBe('new');
  });

  it('rejects short text, an explicit empty severities array, duplicate slots, and a rank-metric delta', () => {
    fails({ ...base, filters: { text: { value: 'ab' } } }, 'filters.text.value');
    fails({ ...base, filters: { severities: [] } }, 'filters.severities');
    fails({ ...base, filters: { titleGap: { slots: [1, 1] } } }, 'filters.titleGap.slots');
    fails({ ...base, filters: { movement: { window: '4w', metric: 'rank', delta: { gt: 0 } } } }, 'filters.movement.delta');
    fails({ ...base, filters: { movement: { window: '4w', metric: 'volume' } } }, 'filters.movement');
  });

  it('names the allowed values when a titleGap slot is out of range', () => {
    try {
      parseSearchInput({ ...base, filters: { titleGap: { slots: [4] } } });
      throw new Error('expected rejection');
    } catch (e) {
      const err = e as ResearchError;
      expect(err.details).toEqual([{ path: 'filters.titleGap.slots.0', message: expect.stringContaining('1|2|3') }]);
    }
  });

  it('rejects the include_not_observed rank shape without a prior lower bound and a current upper bound', () => {
    fails(
      { ...base, filters: { movement: { window: '4w', metric: 'rank', baseline: 'include_not_observed', current: { lt: 100 } } } },
      'filters.movement.baseline',
    );
    const ok = parseSearchInput({
      ...base,
      filters: { movement: { window: '4w', metric: 'rank', baseline: 'include_not_observed', prior: { gt: 100000 }, current: { lt: 10000 } } },
    });
    expect(ok.kind).toBe('new');
  });

  it('keeps movement prior/current inside the metric domain (volume >= 0, rank >= 1); delta may still be negative', () => {
    fails({ ...base, filters: { movement: { window: '4w', metric: 'volume', prior: { gte: -5 } } } }, 'filters.movement.prior');
    fails({ ...base, filters: { movement: { window: '4w', metric: 'rank', current: { lte: 0 } } } }, 'filters.movement.current');
    // No bound is itself below the floor (1), but with no explicit lower bound the floor
    // is the implied one, and { lt: 1 } leaves no integer above it.
    fails({ ...base, filters: { movement: { window: '4w', metric: 'rank', current: { lt: 1 } } } }, 'filters.movement.current');
    const out = parseSearchInput({ ...base, filters: { movement: { window: '4w', metric: 'volume', delta: { lt: -100 } } } });
    expect(out.kind).toBe('new');
    const okVolume = parseSearchInput({
      ...base,
      filters: { movement: { window: '4w', metric: 'volume', baseline: 'include_not_observed', prior: { lt: 5000 } } },
    });
    expect(okVolume.kind).toBe('new');
  });

  it('caps rank-metric movement prior/current at the int4 ceiling too (I3); volume-metric movement bounds stay uncapped (bigint)', () => {
    fails({ ...base, filters: { movement: { window: '4w', metric: 'rank', prior: { gt: 3_000_000_000 } } } }, 'filters.movement.prior');
    const bigVolumeMovement = parseSearchInput({
      ...base,
      filters: { movement: { window: '4w', metric: 'volume', prior: { gte: 3_000_000_000 } } },
    });
    expect(bigVolumeMovement.kind).toBe('new');
  });

  it('does not duplicate bound-count or explicit-bound emptiness issues for a movement range (anyRange already reports those once)', () => {
    for (const prior of [{}, { gt: 1, gte: 2 }, { gte: 10, lte: 5 }, { gt: 5, lt: 6 }]) {
      try {
        parseSearchInput({ ...base, filters: { movement: { window: '4w', metric: 'volume', prior } } });
        throw new Error(`expected rejection at filters.movement.prior for prior=${JSON.stringify(prior)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ResearchError);
        const err = e as ResearchError;
        expect(err.details!.filter((d) => d.path === 'filters.movement.prior')).toHaveLength(1);
      }
    }
    // Floor-seeded emptiness (no explicit lower bound, so the metric floor supplies the
    // implied one) is reported once too, but by checkDomain itself — anyRange never sees
    // this case since it has no way to know the metric-scoped floor.
    try {
      parseSearchInput({ ...base, filters: { movement: { window: '4w', metric: 'volume', prior: { lt: 0 } } } });
      throw new Error('expected rejection at filters.movement.prior for prior={"lt":0}');
    } catch (e) {
      expect(e).toBeInstanceOf(ResearchError);
      const err = e as ResearchError;
      expect(err.details!.filter((d) => d.path === 'filters.movement.prior')).toHaveLength(1);
    }
  });

  it('reports an out-of-domain bound once, but keeps both issues when an explicit lower bound is also out of domain and empty', () => {
    // No explicit lower bound: checkDomain's out-of-domain issue alone, no redundant
    // floor-seeded emptiness issue for the same bound.
    try {
      parseSearchInput({ ...base, filters: { movement: { window: '4w', metric: 'volume', prior: { lte: -1 } } } });
      throw new Error('expected rejection at filters.movement.prior for prior={"lte":-1}');
    } catch (e) {
      expect(e).toBeInstanceOf(ResearchError);
      const err = e as ResearchError;
      expect(err.details!.filter((d) => d.path === 'filters.movement.prior')).toHaveLength(1);
    }
    // Explicit lower bound: anyRange's own superRefine already reported the explicit-bound
    // emptiness (gte 5 > lte -1), and checkDomain separately reports the out-of-domain bound
    // (lte -1 < floor 0) — two distinct, non-redundant issues.
    try {
      parseSearchInput({ ...base, filters: { movement: { window: '4w', metric: 'volume', prior: { gte: 5, lte: -1 } } } });
      throw new Error('expected rejection at filters.movement.prior for prior={"gte":5,"lte":-1}');
    } catch (e) {
      expect(e).toBeInstanceOf(ResearchError);
      const err = e as ResearchError;
      expect(err.details!.filter((d) => d.path === 'filters.movement.prior')).toHaveLength(2);
    }
  });

  it('rejects a comparisonWindow that disagrees with movement.window, accepts an explicit null, and firstSeenWeek sorts', () => {
    fails({ ...base, comparisonWindow: '13w', filters: { movement: { window: '4w', metric: 'volume', delta: { gt: 0 } } } }, 'comparisonWindow');
    fails({ ...base, sort: { field: 'firstSeenWeek', direction: 'asc' } }, 'sort.field');
    const out = parseSearchInput({ ...base, comparisonWindow: null });
    expect(out.kind).toBe('new');
    if (out.kind === 'new') expect(out.request.comparisonWindow).toBeNull();
    expectTypeOf<SearchRequest['comparisonWindow']>().toEqualTypeOf<Window | null>();
  });

  it('caps pageSize at 100, selections at 25, and presetIds at 4 distinct entries', () => {
    fails({ ...base, pageSize: 101 }, 'pageSize');
    const sel = Array.from({ length: 26 }, (_, i) => ({ kind: 'taxonomy', path: `P${i}`, includeDescendants: true }));
    fails({ ...base, filters: { categories: { selections: sel } } }, 'filters.categories.selections');
    fails({ ...base, presetIds: ['high_demand_v1', 'high_demand_v1'] }, 'presetIds');
    fails(
      { ...base, presetIds: ['high_demand_v1', 'low_review_competition_v1', 'growing_4w_v1', 'title_gap_loose_any_v1', 'high_demand_v1'] },
      'presetIds',
    );
  });

  it('returns a continuation for a bare cursor', () => {
    expect(parseSearchInput({ cursor: 'x'.repeat(40) })).toEqual({ kind: 'continuation', cursor: 'x'.repeat(40) });
  });

  it('treats an unparseable cursor as INVALID_CURSOR (not INVALID_FILTERS), but a present-and-undefined cursor as a new search', () => {
    for (const bad of ['short', 123]) {
      try {
        parseSearchInput({ cursor: bad });
        throw new Error(`expected rejection for cursor ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ResearchError);
        const err = e as ResearchError;
        expect(err.code).toBe('INVALID_CURSOR');
        expect(err.details).toEqual([{ path: 'cursor', message: expect.any(String) }]);
      }
    }
    const out = parseSearchInput({ cursor: undefined, schemaVersion: 1 });
    expect(out.kind).toBe('new');
  });

  it('normalizes a fully populated request to the documented defaults', () => {
    const out = parseSearchInput({
      schemaVersion: 1,
      filters: {
        text: { value: 'hair oil' },
        titleGap: { slots: [2] },
        categories: { selections: [{ kind: 'taxonomy', path: 'A' }] },
        movement: { window: '4w', metric: 'volume', delta: { gt: 0 } },
      },
    });
    expect(out).toStrictEqual({
      kind: 'new',
      request: {
        schemaVersion: 1,
        presetIds: [],
        filters: {
          text: { value: 'hair oil', mode: 'word' },
          estimatedMonthlySearches: null,
          averageReviews: null,
          rank: null,
          wordCount: null,
          categories: { selections: [{ kind: 'taxonomy', path: 'A', includeDescendants: true }], leafPaths: [] },
          broadCategory: null,
          severities: ['none', 'warning'],
          titleGap: { slots: [2], quantifier: 'any', mode: 'loose' },
          movement: { window: '4w', metric: 'volume', prior: null, current: null, delta: { gt: 0 }, baseline: 'observed_only' },
        },
        // No `sort` key: zod's `.optional()` omits an absent field entirely rather than
        // setting it to `undefined` (verified against this repo's zod install), and
        // toStrictEqual treats a present-but-undefined key as different from an absent one.
        comparisonWindow: null,
        pageSize: 50,
      },
    });
  });

  it('pins a handful of edge cases', () => {
    expect(emptyInputSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(searchToolInputSchema.safeParse({ schemaVersion: 1, filters: {} }).success).toBe(true);
    expect(searchToolInputSchema.safeParse({ cursor: 'short' }).success).toBe(false);
    fails({ ...base, filters: { categories: { leafPaths: Array.from({ length: 2001 }, (_, i) => `p${i}`) } } }, 'filters.categories.leafPaths');
    fails({ ...base, filters: { categories: { leafPaths: ['x'.repeat(257)] } } }, 'filters.categories.leafPaths.0');
    fails({ ...base, filters: { rank: { gte: NaN } } }, 'filters.rank.gte');
    fails({ ...base, filters: { rank: { lt: Infinity } } }, 'filters.rank.lt');
    for (const bad of [null, 'x']) {
      try {
        parseSearchInput(bad);
        throw new Error('expected rejection at (root)');
      } catch (e) {
        expect(e).toBeInstanceOf(ResearchError);
        const err = e as ResearchError;
        expect(err.code).toBe('INVALID_FILTERS');
        expect(err.details!.some((d) => d.path === '(root)')).toBe(true);
      }
    }
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
