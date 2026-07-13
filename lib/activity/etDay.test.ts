import { describe, expect, it } from 'vitest';
import { etDay, previousEtDay } from './etDay';

describe('etDay', () => {
  it('returns the ET calendar date for a UTC instant that is still "yesterday" in ET', () => {
    // 2026-07-13T03:00:00Z = 2026-07-12 23:00 EDT
    expect(etDay(new Date('2026-07-13T03:00:00Z'))).toBe('2026-07-12');
  });

  it('returns the ET calendar date for a UTC instant just past ET midnight', () => {
    // 2026-07-13T04:30:00Z = 2026-07-13 00:30 EDT
    expect(etDay(new Date('2026-07-13T04:30:00Z'))).toBe('2026-07-13');
  });

  it('handles winter (EST, UTC-5)', () => {
    // 2026-01-15T04:30:00Z = 2026-01-14 23:30 EST
    expect(etDay(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
  });

  it('pads month and day', () => {
    // 2026-03-05T12:00:00Z = 2026-03-05 07:00 EST
    expect(etDay(new Date('2026-03-05T12:00:00Z'))).toBe('2026-03-05');
  });
});

describe('previousEtDay', () => {
  it('subtracts one calendar day', () => {
    // 07:30 EDT on Jul 13 → previous day Jul 12
    expect(previousEtDay(new Date('2026-07-13T11:30:00Z'))).toBe('2026-07-12');
  });

  it('crosses a month boundary', () => {
    // 2026-08-01 07:30 EDT
    expect(previousEtDay(new Date('2026-08-01T11:30:00Z'))).toBe('2026-07-31');
  });

  it('crosses a year boundary', () => {
    // 2026-01-01 07:30 EST = 12:30Z
    expect(previousEtDay(new Date('2026-01-01T12:30:00Z'))).toBe('2025-12-31');
  });

  it('is correct on the spring-forward morning (2026-03-08 is a 23h ET day)', () => {
    // 2026-03-08 07:30 EDT = 11:30Z → previous ET day is 03-07
    expect(previousEtDay(new Date('2026-03-08T11:30:00Z'))).toBe('2026-03-07');
  });

  it('is correct on the fall-back morning (2026-11-01 is a 25h ET day)', () => {
    // 2026-11-01 07:30 EST = 12:30Z → previous ET day is 10-31
    expect(previousEtDay(new Date('2026-11-01T12:30:00Z'))).toBe('2026-10-31');
  });
});
