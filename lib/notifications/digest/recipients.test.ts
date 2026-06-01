// lib/notifications/digest/recipients.test.ts
import { describe, it, expect } from 'vitest';
import { variantFor, chunk, rollupRunStatus } from './recipients';

describe('variantFor', () => {
  it('returns watchlist when count > 0', () => {
    expect(variantFor(1)).toBe('watchlist');
    expect(variantFor(100)).toBe('watchlist');
  });
  it('returns broadcast when count is 0', () => {
    expect(variantFor(0)).toBe('broadcast');
  });
});

describe('chunk', () => {
  it('splits into groups of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('returns one chunk when under the size', () => {
    expect(chunk([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });
  it('returns empty array for empty input', () => {
    expect(chunk([], 100)).toEqual([]);
  });
  it('handles exact multiples', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
});

describe('rollupRunStatus', () => {
  it('is "sent" when there are no failures', () => {
    expect(rollupRunStatus({ sent: 10, failed: 0 })).toBe('sent');
  });
  it('is "sent_with_failures" when some failed but some sent', () => {
    expect(rollupRunStatus({ sent: 7, failed: 3 })).toBe('sent_with_failures');
  });
  it('is "failed" when everything failed', () => {
    expect(rollupRunStatus({ sent: 0, failed: 5 })).toBe('failed');
  });
  it('is "sent" for a zero-recipient run (nothing to fail)', () => {
    expect(rollupRunStatus({ sent: 0, failed: 0 })).toBe('sent');
  });
});
