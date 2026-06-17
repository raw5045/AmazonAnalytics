// lib/notifications/digest/recipients.test.ts
import { describe, it, expect } from 'vitest';
import { variantFor, chunk, rollupRunStatus, isUndeliverableEmail } from './recipients';

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

describe('isUndeliverableEmail', () => {
  it('flags RFC 2606 reserved second-level domains', () => {
    expect(isUndeliverableEmail('integration_123@example.com')).toBe(true);
    expect(isUndeliverableEmail('foo@example.org')).toBe(true);
    expect(isUndeliverableEmail('foo@example.net')).toBe(true);
  });
  it('flags reserved TLDs (.invalid / .test / .example / .localhost) and bare localhost', () => {
    expect(isUndeliverableEmail('csmtest_1@test.invalid')).toBe(true);
    expect(isUndeliverableEmail('foo@host.test')).toBe(true);
    expect(isUndeliverableEmail('foo@sub.example')).toBe(true);
    expect(isUndeliverableEmail('foo@localhost')).toBe(true);
  });
  it('is case-insensitive on the domain', () => {
    expect(isUndeliverableEmail('Foo@EXAMPLE.COM')).toBe(true);
  });
  it('treats malformed addresses (no @ / empty domain / empty local) as undeliverable', () => {
    expect(isUndeliverableEmail('not-an-email')).toBe(true);
    expect(isUndeliverableEmail('foo@')).toBe(true);
    expect(isUndeliverableEmail('@example.com')).toBe(true);
    expect(isUndeliverableEmail('')).toBe(true);
  });
  it('passes real deliverable domains (incl. real domains used by test accounts)', () => {
    expect(isUndeliverableEmail('raw5045@gmail.com')).toBe(false);
    expect(isUndeliverableEmail('rwood@doublewoodsupplements.com')).toBe(false);
    // x.com is a real domain — NOT filtered here (those test accounts are
    // handled by unsubscribing, not by the deliverability filter).
    expect(isUndeliverableEmail('itest_123@x.com')).toBe(false);
  });
});
