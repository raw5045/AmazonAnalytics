import { describe, expect, it } from 'vitest';
import { formatDay, formatFetchTime } from './date';

describe('formatDay', () => {
  it('reads a stored date as "Mon D, YYYY" without a leading zero on the day', () => {
    expect(formatDay('2026-10-17')).toBe('Oct 17, 2026');
    expect(formatDay('2026-08-01')).toBe('Aug 1, 2026');
    expect(formatDay('2025-12-25')).toBe('Dec 25, 2025');
    expect(formatDay('2026-01-09')).toBe('Jan 9, 2026');
  });

  it('takes the day off an ISO timestamp and ignores the clock', () => {
    expect(formatDay('2026-10-04T06:00:12.345Z')).toBe('Oct 4, 2026');
  });

  it('returns anything that is not a YYYY-MM-DD unchanged, including an invalid month or an extra digit', () => {
    expect(formatDay('2026-13-01')).toBe('2026-13-01');
    expect(formatDay('2026-00-10')).toBe('2026-00-10');
    expect(formatDay('2026-10-171')).toBe('2026-10-171');
    expect(formatDay('n/a')).toBe('n/a');
    expect(formatDay('')).toBe('');
  });
});

describe('formatFetchTime', () => {
  it('adds the UTC clock of an ISO timestamp', () => {
    expect(formatFetchTime('2026-10-04T06:00:12.345Z')).toBe('Oct 4, 2026 06:00 UTC');
    expect(formatFetchTime('2026-10-04T23:59:00Z')).toBe('Oct 4, 2026 23:59 UTC');
  });

  it('a date without a clock is just the day', () => {
    expect(formatFetchTime('2026-10-04')).toBe('Oct 4, 2026');
  });

  it('non-date input is unchanged, even with a clock behind an invalid date', () => {
    expect(formatFetchTime('soon')).toBe('soon');
    expect(formatFetchTime('2026-13-01T06:00:00Z')).toBe('2026-13-01T06:00:00Z');
  });
});
