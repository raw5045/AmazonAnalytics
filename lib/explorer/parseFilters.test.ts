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
      category: 'Electronics',
      severities: ['warning', 'critical'],
      titleSlots: [1, 2],
      titleMatchMode: 'all',
      sort: 'imp',
      page: 3,
      perPage: 50,
    });
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
