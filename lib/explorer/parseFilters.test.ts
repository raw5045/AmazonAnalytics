import { describe, it, expect } from 'vitest';
import {
  parseExplorerFilters,
  EXPLORER_DEFAULTS,
  parseLeafPaths,
  MAX_LEAF_PATHS,
  MAX_LEAF_PATH_LENGTH,
  MAX_CUSTOM_CATEGORY_IDS,
  MAX_EXPLORER_OFFSET,
} from './parseFilters';

describe('parseExplorerFilters', () => {
  it('returns full defaults for empty searchParams', () => {
    expect(parseExplorerFilters({})).toEqual(EXPLORER_DEFAULTS);
  });

  it('parses every valid param', () => {
    const filters = parseExplorerFilters({
      window: '4w',
      q: 'wireless',
      rank_min: '1',
      rank_max: '1000',
      words_min: '3',
      words_max: '5',
      reviews_min: '250',
      reviews_max: '900',
      jump: '500k_to_100k',
      category: 'Electronics',
      severity: 'warning,critical',
      titles: '1,2',
      title_match: 'all',
      match_mode: 'strict',
      sort: 'imp',
      page: '3',
      per_page: '50',
    });
    expect(filters).toEqual({
      window: '4w',
      q: 'wireless',
      qMode: 'word',
      rankMin: 1,
      rankMax: 1000,
      wordsMin: 3,
      wordsMax: 5,
      reviewsMin: 250,
      reviewsMax: 900,
      jump: '500k_to_100k',
      jumpMetric: 'rank',
      jumpFrom: null,
      jumpTo: null,
      category: 'Electronics',
      leafPaths: [],
      customCategoryIds: [],
      severities: ['warning', 'critical'],
      titleSlots: [1, 2],
      titleMatchMode: 'all',
      matchMode: 'strict',
      sort: 'imp',
      page: 3,
      perPage: 50,
    });
  });

  it('parseExplorerFilters reads repeated leaf params as leafPaths', () => {
    const f = parseExplorerFilters({ leaf: ['Clothing, Shoes & Jewelry › Pants', 'Books › Subjects › Self-Help › General'] });
    expect(f.leafPaths).toEqual(['Clothing, Shoes & Jewelry › Pants', 'Books › Subjects › Self-Help › General']);
  });

  it('returns empty array for missing leaf param', () => {
    expect(parseExplorerFilters({}).leafPaths).toEqual([]);
  });

  it('parses custom threshold jump with both bounds', () => {
    const filters = parseExplorerFilters({
      jump: 'custom',
      jump_from: '201000',
      jump_to: '75000',
    });
    expect(filters.jump).toBe('custom');
    expect(filters.jumpFrom).toBe(201000);
    expect(filters.jumpTo).toBe(75000);
  });

  it('drops custom jump when bounds are missing or reversed', () => {
    expect(parseExplorerFilters({ jump: 'custom' }).jump).toBeNull();
    expect(parseExplorerFilters({ jump: 'custom', jump_from: '100' }).jump).toBeNull();
    // from <= to is rejected (would be a non-improvement)
    expect(parseExplorerFilters({ jump: 'custom', jump_from: '100', jump_to: '500' }).jump).toBeNull();
  });

  it('clears jumpFrom/jumpTo when jump is a preset', () => {
    const filters = parseExplorerFilters({
      jump: '500k_to_100k',
      jump_from: '999999',
      jump_to: '1',
    });
    expect(filters.jump).toBe('500k_to_100k');
    expect(filters.jumpFrom).toBeNull();
    expect(filters.jumpTo).toBeNull();
  });

  it('matchMode defaults to loose', () => {
    expect(parseExplorerFilters({}).matchMode).toBe('loose');
  });

  it('invalid match_mode falls back to loose', () => {
    expect(parseExplorerFilters({ match_mode: 'fuzzy' }).matchMode).toBe('loose');
  });

  it('falls back to defaults for invalid enum values', () => {
    const filters = parseExplorerFilters({
      window: 'invalid',
      sort: 'bogus',
      jump: 'wrong',
      title_match: 'maybe',
    });
    expect(filters.window).toBe(EXPLORER_DEFAULTS.window);
    expect(filters.sort).toBe(EXPLORER_DEFAULTS.sort);
    expect(filters.jump).toBeNull();
    expect(filters.titleMatchMode).toBeNull();
  });

  it('drops invalid severity values silently and falls back if all invalid', () => {
    const f1 = parseExplorerFilters({ severity: 'warning,bogus' });
    expect(f1.severities).toEqual(['warning']);
    const f2 = parseExplorerFilters({ severity: 'bogus,bogus2' });
    expect(f2.severities).toEqual(EXPLORER_DEFAULTS.severities);
  });

  it('drops invalid title slot values silently', () => {
    const f1 = parseExplorerFilters({ titles: '1,4,2,99' });
    expect(f1.titleSlots).toEqual([1, 2]);
    const f2 = parseExplorerFilters({ titles: 'foo' });
    expect(f2.titleSlots).toEqual(EXPLORER_DEFAULTS.titleSlots);
  });

  it('q under 3 chars is treated as null', () => {
    expect(parseExplorerFilters({ q: 'ab' }).q).toBeNull();
    expect(parseExplorerFilters({ q: 'abc' }).q).toBe('abc');
  });

  it('q is trimmed', () => {
    expect(parseExplorerFilters({ q: '   wireless   ' }).q).toBe('wireless');
  });

  it('caps per_page at 500', () => {
    expect(parseExplorerFilters({ per_page: '99999' }).perPage).toBe(500);
  });

  it('clamps an absurd page so the OFFSET stays bounded', () => {
    const f = parseExplorerFilters({ page: '99999', per_page: '100' });
    expect((f.page - 1) * f.perPage).toBeLessThanOrEqual(MAX_EXPLORER_OFFSET);
    expect(f.page).toBeLessThan(99999);
  });

  it('leaves a normal page number unclamped', () => {
    expect(parseExplorerFilters({ page: '5' }).page).toBe(5);
  });

  it('treats negative or zero rank values as null', () => {
    const f = parseExplorerFilters({ rank_min: '0', rank_max: '-5' });
    expect(f.rankMin).toBeNull();
    expect(f.rankMax).toBeNull();
  });

  it('handles array-form params (Next.js can pass string[])', () => {
    const f = parseExplorerFilters({ window: ['52w', '1w'] });
    expect(f.window).toBe('52w');
  });
});

describe('parseLeafPaths', () => {
  it('returns [] for undefined', () => expect(parseLeafPaths(undefined)).toEqual([]));
  it('wraps a single string path', () =>
    expect(parseLeafPaths('Health & Household › Air Fresheners'))
      .toEqual(['Health & Household › Air Fresheners']));
  it('keeps repeated params as separate paths', () =>
    expect(parseLeafPaths(['A › B', 'C › D'])).toEqual(['A › B', 'C › D']));
  it('does NOT split on commas in department names', () =>
    expect(parseLeafPaths(['Clothing, Shoes & Jewelry › Pants']))
      .toEqual(['Clothing, Shoes & Jewelry › Pants']));
  it('trims and drops blanks', () =>
    expect(parseLeafPaths(['  A › B  ', '', '  '])).toEqual(['A › B']));
  it('drops paths longer than the per-path cap', () => {
    const long = 'x'.repeat(MAX_LEAF_PATH_LENGTH + 1);
    expect(parseLeafPaths(['A › B', long])).toEqual(['A › B']);
  });
  it('caps the number of paths', () => {
    const many = Array.from({ length: MAX_LEAF_PATHS + 50 }, (_, i) => `Dept › Leaf ${i}`);
    expect(parseLeafPaths(many)).toHaveLength(MAX_LEAF_PATHS);
  });
});

describe('parseExplorerFilters — Movement jump', () => {
  it('defaults jumpMetric to rank', () => {
    expect(parseExplorerFilters({}).jumpMetric).toBe('rank');
  });
  it('parses jump_metric=volume', () => {
    expect(parseExplorerFilters({ jump_metric: 'volume' }).jumpMetric).toBe('volume');
  });
  it('infers volume metric from a volume preset id', () => {
    const f = parseExplorerFilters({ jump: 'v15k_to_30k' });
    expect(f.jump).toBe('v15k_to_30k');
    expect(f.jumpMetric).toBe('volume');
  });
  it('infers rank metric from a rank preset id even if jump_metric says otherwise', () => {
    const f = parseExplorerFilters({ jump: '100k_to_50k', jump_metric: 'volume' });
    expect(f.jumpMetric).toBe('rank');
  });
  it('rank custom requires from > to', () => {
    const ok = parseExplorerFilters({ jump: 'custom', jump_metric: 'rank', jump_from: '100000', jump_to: '50000' });
    expect(ok.jump).toBe('custom');
    const bad = parseExplorerFilters({ jump: 'custom', jump_metric: 'rank', jump_from: '50000', jump_to: '100000' });
    expect(bad.jump).toBeNull();
  });
  it('volume custom requires from < to', () => {
    const ok = parseExplorerFilters({ jump: 'custom', jump_metric: 'volume', jump_from: '5000', jump_to: '15000' });
    expect(ok.jump).toBe('custom');
    const bad = parseExplorerFilters({ jump: 'custom', jump_metric: 'volume', jump_from: '15000', jump_to: '5000' });
    expect(bad.jump).toBeNull();
  });
});

describe('parseExplorerFilters — qMode', () => {
  it('defaults qMode to word', () => {
    expect(parseExplorerFilters({}).qMode).toBe('word');
  });
  it('parses qmode=broad', () => {
    expect(parseExplorerFilters({ q: 'hair', qmode: 'broad' }).qMode).toBe('broad');
  });
  it('falls back to word for an invalid qmode', () => {
    expect(parseExplorerFilters({ qmode: 'fuzzy' }).qMode).toBe('word');
  });
});

describe('parseExplorerFilters — customCategoryIds', () => {
  it('parses the custom param into customCategoryIds', () => {
    const f = parseExplorerFilters({ custom: 'id-1,id-2' });
    expect(f.customCategoryIds).toEqual(['id-1', 'id-2']);
  });
  it('defaults customCategoryIds to []', () => {
    expect(parseExplorerFilters({}).customCategoryIds).toEqual([]);
  });
  it('caps the number of custom category ids', () => {
    const many = Array.from({ length: MAX_CUSTOM_CATEGORY_IDS + 10 }, (_, i) => `id-${i}`).join(',');
    expect(parseExplorerFilters({ custom: many }).customCategoryIds).toHaveLength(MAX_CUSTOM_CATEGORY_IDS);
  });
});

describe('parseExplorerFilters — avg-reviews range', () => {
  it('parses reviews_min and reviews_max', () => {
    const f = parseExplorerFilters({ reviews_min: '100', reviews_max: '500' });
    expect(f.reviewsMin).toBe(100);
    expect(f.reviewsMax).toBe(500);
  });

  it('accepts 0 as a bound (zero-review niches)', () => {
    const f = parseExplorerFilters({ reviews_max: '0' });
    expect(f.reviewsMin).toBeNull();
    expect(f.reviewsMax).toBe(0);
    // min=0 must parse as an active 0, not fall back to null — once the SQL
    // predicate lands, min=0 excludes NULL avg_reviews rows while null doesn't.
    expect(parseExplorerFilters({ reviews_min: '0' }).reviewsMin).toBe(0);
  });

  it('defaults to null and rejects garbage', () => {
    expect(parseExplorerFilters({}).reviewsMin).toBeNull();
    expect(parseExplorerFilters({}).reviewsMax).toBeNull();
    const bad = parseExplorerFilters({ reviews_min: '-3', reviews_max: 'abc' });
    expect(bad.reviewsMin).toBeNull();
    expect(bad.reviewsMax).toBeNull();
  });
});

describe('parseExplorerFilters — word-count range', () => {
  it('parses words_min and words_max', () => {
    const f = parseExplorerFilters({ words_min: '3', words_max: '5' });
    expect(f.wordsMin).toBe(3);
    expect(f.wordsMax).toBe(5);
  });

  it('accepts the exactly-one-word form (owner example: 1–1)', () => {
    const f = parseExplorerFilters({ words_min: '1', words_max: '1' });
    expect(f.wordsMin).toBe(1);
    expect(f.wordsMax).toBe(1);
  });

  it('defaults to null and rejects zero/garbage (floors at 1)', () => {
    expect(parseExplorerFilters({}).wordsMin).toBeNull();
    expect(parseExplorerFilters({}).wordsMax).toBeNull();
    const bad = parseExplorerFilters({ words_min: '0', words_max: 'abc' });
    expect(bad.wordsMin).toBeNull();
    expect(bad.wordsMax).toBeNull();
  });
});
