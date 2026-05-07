import { describe, it, expect } from 'vitest';
import {
  cleanSearchTermForDisplay,
  hadUnicodeNoise,
  normalizeForMatch,
  keywordInTitle,
  computeTitleMatchCount,
} from './derivedFields';

// Helper to keep tests readable when expressing invisible chars
const OBJ = '￼'; // OBJECT REPLACEMENT CHARACTER
const ZWSP = '​'; // ZERO WIDTH SPACE
const BOM = '﻿';
const NBSP = ' ';
const NARROW_NBSP = ' ';
const SOFT_HYPHEN = '­';
const LRM = '‎';
const C0 = ''; // arbitrary C0 control

describe('cleanSearchTermForDisplay', () => {
  it('strips OBJECT REPLACEMENT CHARACTER (the main offender)', () => {
    expect(cleanSearchTermForDisplay(OBJ + 'essential oils')).toBe('essential oils');
    expect(cleanSearchTermForDisplay('essential' + OBJ + ' oils')).toBe('essential oils');
  });

  it('strips zero-width and BOM characters', () => {
    expect(cleanSearchTermForDisplay(ZWSP + 'foo' + ZWSP + 'bar')).toBe('foobar');
    expect(cleanSearchTermForDisplay(BOM + 'magic eraser')).toBe('magic eraser');
  });

  it('strips bidi marks', () => {
    expect(cleanSearchTermForDisplay(LRM + 'shorts for women')).toBe('shorts for women');
  });

  it('strips soft hyphen and other format characters', () => {
    expect(cleanSearchTermForDisplay('soft' + SOFT_HYPHEN + 'hyphen')).toBe('softhyphen');
  });

  it('strips C0 control characters', () => {
    expect(cleanSearchTermForDisplay('foo' + C0 + 'bar')).toBe('foobar');
  });

  it('maps NBSP and narrow NBSP to ordinary space', () => {
    expect(cleanSearchTermForDisplay('foo' + NBSP + 'bar')).toBe('foo bar');
    expect(cleanSearchTermForDisplay('foo' + NARROW_NBSP + 'bar')).toBe('foo bar');
  });

  it('preserves capitalization', () => {
    expect(cleanSearchTermForDisplay('AAA Batteries')).toBe('AAA Batteries');
  });

  it('preserves accents and ñ (NFC composed form)', () => {
    expect(cleanSearchTermForDisplay('café')).toBe('café');
    expect(cleanSearchTermForDisplay('niños')).toBe('niños');
  });

  it('preserves punctuation that has semantic meaning', () => {
    expect(cleanSearchTermForDisplay("p&j essential oils")).toBe("p&j essential oils");
    expect(cleanSearchTermForDisplay("nature's bounty")).toBe("nature's bounty");
  });

  it('collapses runs of whitespace', () => {
    expect(cleanSearchTermForDisplay('foo    bar')).toBe('foo bar');
  });

  it('trims leading/trailing whitespace', () => {
    expect(cleanSearchTermForDisplay('  foo bar  ')).toBe('foo bar');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(cleanSearchTermForDisplay(null)).toBe('');
    expect(cleanSearchTermForDisplay(undefined)).toBe('');
    expect(cleanSearchTermForDisplay('')).toBe('');
  });

  it('returns empty string for input that is entirely noise', () => {
    expect(cleanSearchTermForDisplay(OBJ + ZWSP + BOM)).toBe('');
  });

  it('handles the exact production case from the bug report', () => {
    // search_terms.search_term_raw = "￼essential oils"
    expect(cleanSearchTermForDisplay('￼essential oils')).toBe('essential oils');
  });
});

describe('hadUnicodeNoise', () => {
  it('returns true when invisible chars are present', () => {
    expect(hadUnicodeNoise(OBJ + 'essential oils')).toBe(true);
    expect(hadUnicodeNoise(BOM + 'foo')).toBe(true);
  });

  it('returns true when NBSP-style space needs replacing', () => {
    expect(hadUnicodeNoise('foo' + NBSP + 'bar')).toBe(true);
  });

  it('returns true when leading/trailing whitespace needs trimming', () => {
    expect(hadUnicodeNoise('  foo')).toBe(true);
  });

  it('returns true when whitespace runs need collapsing', () => {
    expect(hadUnicodeNoise('foo  bar')).toBe(true);
  });

  it('returns false on already-clean input', () => {
    expect(hadUnicodeNoise('essential oils')).toBe(false);
    expect(hadUnicodeNoise('AAA Batteries')).toBe(false);
    expect(hadUnicodeNoise('café')).toBe(false);
  });

  it('returns false for empty/null', () => {
    expect(hadUnicodeNoise(null)).toBe(false);
    expect(hadUnicodeNoise('')).toBe(false);
  });
});

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

  it('treats OBJ-prefixed and clean as the same normalized value', () => {
    expect(normalizeForMatch(OBJ + 'essential oils')).toBe('essential oils');
    expect(normalizeForMatch('essential oils')).toBe('essential oils');
  });

  it('NFKC collapses ligatures into their base ASCII', () => {
    // U+FB03 is the "ffi" ligature
    expect(normalizeForMatch('oﬃce')).toBe('office');
  });

  it('NFKC collapses fullwidth into halfwidth', () => {
    // FULLWIDTH LATIN CAPITAL LETTERS — common in CSV exports from Asian sites
    expect(normalizeForMatch('ＨＥＬＬＯ')).toBe('hello');
  });

  it("strips apostrophes (Nature's matches Natures)", () => {
    expect(normalizeForMatch("nature's bounty")).toBe('natures bounty');
    expect(normalizeForMatch('nature’s bounty')).toBe('natures bounty');
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
