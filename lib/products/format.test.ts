// lib/products/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatBadge, formatRatio, availabilityLabel, listingAge, formatPriceCents, formatReviewCount, formatVolume } from './format';

const MINUS = String.fromCodePoint(0x2212);
const NOW = new Date('2026-10-09');

describe('formatBadge', () => {
  const cases: Array<[number | null, string]> = [
    [1000, '1,000+'],
    [50, '50+'],
    [100000, '100,000+'],
    [null, '—'],
  ];
  it.each(cases)('formatBadge(%s) → %s', (input, expected) => {
    expect(formatBadge(input)).toBe(expected);
  });
});

describe('formatRatio', () => {
  const cases: Array<[number | null, string]> = [
    [65, `${MINUS}35%`],
    [100, '0%'],
    [130, '+30%'],
    [99, `${MINUS}1%`],
    [101, '+1%'],
    [2500, '+2,400%'],
    [null, '—'],
  ];
  it.each(cases)('formatRatio(%s) → %s', (input, expected) => {
    expect(formatRatio(input)).toBe(expected);
  });
  it('uses the real minus sign (U+2212), not a hyphen', () => {
    expect(formatRatio(65).codePointAt(0)).toBe(0x2212);
    expect(formatRatio(65)).not.toContain('-');
  });
});

describe('availabilityLabel', () => {
  const cases: Array<[number | null, string]> = [
    [-1, 'No Amazon offer'],
    [0, 'In stock'],
    [1, 'Pre-order'],
    [2, 'Unknown'],
    [3, 'Back-order'],
    [4, 'Delayed'],
    [null, '—'],
    [9, 'Unknown'], // a code Keepa has not documented: we cannot tell, so say so
  ];
  it.each(cases)('availabilityLabel(%s) → %s', (input, expected) => {
    expect(availabilityLabel(input)).toBe(expected);
  });
});

describe('listingAge', () => {
  const cases: Array<[string | null, string]> = [
    ['2026-07-01', '100 days'],
    ['2025-09-04', '1.1 years'], // 400 days
    ['2026-10-09', '0 days'],
    ['2026-10-08', '1 day'],
    ['2025-10-10', '364 days'],
    ['2025-10-09', '1.0 years'], // 365 days
    ['2024-10-09', '2.0 years'],
    ['2026-10-20', '0 days'], // dated after now (clock skew): never negative
    [null, '—'],
    ['not a date', '—'],
  ];
  it.each(cases)('listingAge(%s) → %s', (input, expected) => {
    expect(listingAge(input, NOW)).toBe(expected);
  });
  it('counts UTC calendar days, whatever the time of day or the machine time zone', () => {
    expect(listingAge('2026-07-01', new Date('2026-10-09T23:59:59Z'))).toBe('100 days');
    expect(listingAge('2026-07-01', new Date('2026-10-10T00:00:01Z'))).toBe('101 days');
  });
  it('shows a dash when now is not a valid date', () => {
    expect(listingAge('2026-07-01', new Date('nope'))).toBe('—');
  });
});

describe('formatPriceCents', () => {
  const cases: Array<[number | null, string]> = [
    [1999, '$19.99'],
    [5, '$0.05'],
    [0, '$0.00'],
    [123456, '$1,234.56'],
    [null, '—'],
  ];
  it.each(cases)('formatPriceCents(%s) → %s', (input, expected) => {
    expect(formatPriceCents(input)).toBe(expected);
  });
});

describe('formatReviewCount', () => {
  const cases: Array<[number | null, string]> = [
    [1834, '1.8k'],
    [999, '999'],
    [0, '0'],
    [1000, '1.0k'],
    [12345, '12.3k'],
    [999949, '999.9k'],
    [999950, '1.0M'], // never "1000.0k"
    [1200000, '1.2M'],
    [null, '—'],
  ];
  it.each(cases)('formatReviewCount(%s) → %s', (input, expected) => {
    expect(formatReviewCount(input)).toBe(expected);
  });
});

describe('formatVolume', () => {
  // A copy of the keyword page's local formatHeadlineVolume (same output): the locale-formatted
  // count and " / mo". The "~" estimate prefix is the caller's, as on the keyword page.
  it('is the keyword page headline format', () => {
    expect(formatVolume(4879000)).toBe(`${(4879000).toLocaleString()} / mo`);
    expect(formatVolume(0)).toBe(`${(0).toLocaleString()} / mo`);
    expect(formatVolume(1234)).not.toContain('~');
  });
  it('shows a dash for a missing estimate', () => {
    expect(formatVolume(null)).toBe('—');
  });
});
