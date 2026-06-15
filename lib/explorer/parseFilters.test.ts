import { describe, it, expect } from 'vitest';
import { parseExplorerFilters, EXPLORER_DEFAULTS } from './parseFilters';

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
      rankMin: 1,
      rankMax: 1000,
      jump: '500k_to_100k',
      jumpMetric: 'rank',
      jumpFrom: null,
      jumpTo: null,
      category: 'Electronics',
      leafCategories: [],
      severities: ['warning', 'critical'],
      titleSlots: [1, 2],
      titleMatchMode: 'all',
      matchMode: 'strict',
      sort: 'imp',
      page: 3,
      perPage: 50,
    });
  });

  it('parses single leaf-category filter', () => {
    const f = parseExplorerFilters({ leaf: 'Face Moisturizers' });
    expect(f.leafCategories).toEqual(['Face Moisturizers']);
  });

  it('parses multiple comma-separated leaf categories', () => {
    const f = parseExplorerFilters({ leaf: 'Face Moisturizers,Anti-aging Creams,Toilet Paper' });
    expect(f.leafCategories).toEqual(['Face Moisturizers', 'Anti-aging Creams', 'Toilet Paper']);
  });

  it('trims whitespace and drops empty entries from leaf list', () => {
    const f = parseExplorerFilters({ leaf: '  Foo, , Bar  ,Baz' });
    expect(f.leafCategories).toEqual(['Foo', 'Bar', 'Baz']);
  });

  it('returns empty array for missing leaf param', () => {
    expect(parseExplorerFilters({}).leafCategories).toEqual([]);
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
