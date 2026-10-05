// lib/keepa/lanes.test.ts
import { describe, it, expect } from 'vitest';
import {
  tierForRank,
  nextDueAfterSuccess,
  nextDueAfterDelisted,
  nextDueAfterError,
  msUntilTokens,
  TIER1_MAX_RANK,
  TOKENS_PER_ASIN,
  BATCH_SIZE,
} from './lanes';

const NOW = new Date('2026-10-06T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('tierForRank', () => {
  it('puts rank 1,000,000 in tier 1 and 1,000,001 in tier 2', () => {
    expect(tierForRank(1)).toBe(1);
    expect(tierForRank(TIER1_MAX_RANK)).toBe(1);
    expect(tierForRank(TIER1_MAX_RANK + 1)).toBe(2);
  });
});

describe('next-due rules (spec §5.2)', () => {
  it('tier 1 refreshes weekly, tier 2 monthly', () => {
    expect(nextDueAfterSuccess(1, NOW)).toEqual(days(7));
    expect(nextDueAfterSuccess(2, NOW)).toEqual(days(30));
  });
  it('a delisted ASIN is rechecked after 30 days', () => {
    expect(nextDueAfterDelisted(NOW)).toEqual(days(30));
  });
  it('errors back off 1, 2, 4 days and cap at 7', () => {
    expect(nextDueAfterError(1, NOW)).toEqual(days(1));
    expect(nextDueAfterError(2, NOW)).toEqual(days(2));
    expect(nextDueAfterError(3, NOW)).toEqual(days(4));
    expect(nextDueAfterError(4, NOW)).toEqual(days(7));
    expect(nextDueAfterError(9, NOW)).toEqual(days(7));
    expect(nextDueAfterError(0, NOW)).toEqual(days(1));
  });
});

describe('msUntilTokens', () => {
  it('is zero with headroom or an unknown balance', () => {
    expect(msUntilTokens(15_000, 250, 200)).toBe(0);
    expect(msUntilTokens(200, 250, 200)).toBe(0);
    expect(msUntilTokens(null, 250, 200)).toBe(0);
  });
  it('waits for the shortfall at the refill rate (250/min: 100 tokens short = 24 s)', () => {
    expect(msUntilTokens(100, 250, 200)).toBe(24_000);
    expect(msUntilTokens(0, 250, 200)).toBe(48_000);
  });
  it('assumes 250/min when the rate is unknown', () => {
    expect(msUntilTokens(0, null, 200)).toBe(48_000);
  });
  it('a full batch costs 200 tokens', () => {
    expect(BATCH_SIZE * TOKENS_PER_ASIN).toBe(200);
  });
});
