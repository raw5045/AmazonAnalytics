import { describe, it, expect } from 'vitest';
import { normalizeForMatch, keywordInTitle, computeTitleMatchCount } from './derivedFields';

describe('normalizeForMatch', () => {
  it('lowercases and trims', () => {
    expect(normalizeForMatch('  Hello World  ')).toBe('hello world');
  });

  it('replaces punctuation with spaces', () => {
    expect(normalizeForMatch('hello-world,2025!')).toBe('hello world 2025');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeForMatch('hello    world')).toBe('hello world');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeForMatch(null)).toBe('');
    expect(normalizeForMatch(undefined)).toBe('');
  });
});

describe('keywordInTitle', () => {
  it('returns true when keyword appears as contiguous phrase', () => {
    expect(keywordInTitle('magnesium glycinate', 'Pure Magnesium Glycinate 500mg')).toBe(true);
  });

  it('returns false when keyword is not in title', () => {
    expect(keywordInTitle('magnesium glycinate', 'Vitamin C Gummies')).toBe(false);
  });

  it('handles punctuation differences', () => {
    expect(keywordInTitle("nature's bounty", 'NATURES BOUNTY 120 ct')).toBe(true);
  });

  it('returns false for empty/null title', () => {
    expect(keywordInTitle('anything', null)).toBe(false);
    expect(keywordInTitle('anything', '')).toBe(false);
  });
});

describe('computeTitleMatchCount', () => {
  it('counts how many of 3 titles contain the keyword', () => {
    expect(
      computeTitleMatchCount('magnesium', [
        'Pure Magnesium',
        'Vitamin C',
        'Magnesium 500mg',
      ]),
    ).toBe(2);
  });

  it('returns 0 when no title matches', () => {
    expect(computeTitleMatchCount('xyz', ['Apple', 'Banana', 'Cherry'])).toBe(0);
  });

  it('handles nulls in title list', () => {
    expect(computeTitleMatchCount('magnesium', ['Magnesium', null, null])).toBe(1);
  });
});
