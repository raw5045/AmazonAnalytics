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
  TOKEN_RESERVE,
  REFILL_MARGIN_MS,
} from './lanes';

const NOW = new Date('2026-10-06T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('tierForRank', () => {
  it('puts rank 1,000,000 in tier 1 and 1,000,001 in tier 2', () => {
    expect(TIER1_MAX_RANK).toBe(1_000_000);
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
    expect(msUntilTokens(15_000, 250, 200, null)).toBe(0);
    expect(msUntilTokens(200, 250, 200, null)).toBe(0);
    expect(msUntilTokens(null, 250, 200, null)).toBe(0);
    expect(msUntilTokens(300, 250, 250, 12_345)).toBe(0);
    expect(msUntilTokens(null, 250, 250, 12_345)).toBe(0);
  });
  it('without a refill time: waits for the shortfall at the refill rate (250/min: 100 tokens short = 24 s)', () => {
    expect(msUntilTokens(100, 250, 200, null)).toBe(24_000);
    expect(msUntilTokens(0, 250, 200, null)).toBe(48_000);
    expect(msUntilTokens(100, 250, 200, -5)).toBe(24_000);
  });
  it('assumes 250/min when the rate is unknown', () => {
    expect(msUntilTokens(0, null, 200, null)).toBe(48_000);
    // 600 short at the assumed 250/min is three refills (at 100/min it would be six).
    expect(msUntilTokens(0, null, 600, 1_000)).toBe(1_000 + 2 * 60_000 + REFILL_MARGIN_MS);
  });
  it('treats a zero or negative reported rate as unknown', () => {
    expect(msUntilTokens(0, 0, 200, null)).toBe(48_000);
    expect(msUntilTokens(0, -5, 200, null)).toBe(48_000);
  });
  it('with a refill time: one refill short waits for the next refill plus the margin', () => {
    expect(msUntilTokens(57, 250, 250, 12_345)).toBe(12_845);
    expect(msUntilTokens(57, 250, 250, 0)).toBe(REFILL_MARGIN_MS);
  });
  it('several refills short adds a minute per further refill', () => {
    // 250 short at 100/min: three refills, the next one and two more.
    expect(msUntilTokens(0, 100, 250, 5_000)).toBe(5_000 + 120_000 + 500);
  });
  it('counts a negative balance (Keepa lets it dip) in the shortfall', () => {
    // 250 needed, -89 left: 339 short at 250/min is two refills.
    expect(msUntilTokens(-89, 250, 250, 30_000)).toBe(30_000 + 60_000 + 500);
  });
  it('a full batch costs 200 tokens; with the reserve it takes 250, one minute\'s refill', () => {
    expect(BATCH_SIZE * TOKENS_PER_ASIN).toBe(200);
    expect(BATCH_SIZE * TOKENS_PER_ASIN + TOKEN_RESERVE).toBe(250);
  });
});
