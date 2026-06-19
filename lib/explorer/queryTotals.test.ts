import { describe, it, expect } from 'vitest';
import { applyCountCap, extractCount, extractWindowTotal } from './queryTotals';
import { COUNT_CAP } from './buildQuery';

describe('applyCountCap', () => {
  it('passes through values at or below the cap', () => {
    expect(applyCountCap(0)).toEqual({ total: 0, totalIsCapped: false });
    expect(applyCountCap(COUNT_CAP)).toEqual({ total: COUNT_CAP, totalIsCapped: false });
  });
  it('caps values above the cap and flags it', () => {
    expect(applyCountCap(COUNT_CAP + 1)).toEqual({ total: COUNT_CAP, totalIsCapped: true });
    expect(applyCountCap(999_999)).toEqual({ total: COUNT_CAP, totalIsCapped: true });
  });
});

describe('extractCount', () => {
  it('reads total from the first row (number or bigint-string)', () => {
    expect(extractCount([{ total: 42 }])).toBe(42);
    expect(extractCount([{ total: '42' }])).toBe(42);
  });
  it('returns 0 for an empty result', () => {
    expect(extractCount([])).toBe(0);
  });
});

describe('extractWindowTotal', () => {
  it('returns the total from the first row', () => {
    expect(extractWindowTotal([{ total: 7 }, { total: 7 }])).toBe(7);
    expect(extractWindowTotal([{ total: '7' }])).toBe(7);
  });
  it('returns null for an empty page (no row carries the total)', () => {
    expect(extractWindowTotal([])).toBeNull();
  });
  it('returns null when a row is present but carries no usable total', () => {
    // The guard that distinguishes this from extractCount: a row exists but
    // its `total` is absent → signal the caller to run the fallback count.
    expect(extractWindowTotal([{}])).toBeNull();
  });
});
