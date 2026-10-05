// lib/keepa/lanes.ts
/**
 * Pure scheduling rules for the Keepa service (spec 2026-10-05 §5.1–§5.2).
 *
 * Tier 1 = ASINs behind the top TIER1_MAX_RANK keywords, refreshed weekly.
 * Tier 2 = the rest, refreshed monthly, only when the tail lane is on.
 * No I/O here; the service (services/keepa) and the enqueue hook import these.
 */
export const TIER1_MAX_RANK = 1_000_000;
export const TIER1_REFRESH_DAYS = 7;
export const TIER2_REFRESH_DAYS = 30;
export const DELISTED_RETRY_DAYS = 30;
export const ERROR_BACKOFF_BASE_DAYS = 1;
export const ERROR_BACKOFF_CAP_DAYS = 7;
/** A claim older than this belongs to a dead process and is released. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** Keepa's per-request maximum. */
export const BATCH_SIZE = 100;
/** 1 base token + 1 for the rating/review history (`rating=1`). */
export const TOKENS_PER_ASIN = 2;
/** Assumed when Keepa has not told us the rate yet (the plan verified on 2026-10-05). */
export const DEFAULT_REFILL_RATE_PER_MIN = 250;

export type Tier = 1 | 2;
export type Lane = 'new' | 'due' | 'tail';

const DAY_MS = 86_400_000;

export function tierForRank(bestRank: number): Tier {
  return bestRank <= TIER1_MAX_RANK ? 1 : 2;
}

export function nextDueAfterSuccess(tier: Tier, now: Date): Date {
  const days = tier === 1 ? TIER1_REFRESH_DAYS : TIER2_REFRESH_DAYS;
  return new Date(now.getTime() + days * DAY_MS);
}

export function nextDueAfterDelisted(now: Date): Date {
  return new Date(now.getTime() + DELISTED_RETRY_DAYS * DAY_MS);
}

/** `consecutiveErrors` is the count AFTER this failure (1 on the first failure). */
export function nextDueAfterError(consecutiveErrors: number, now: Date): Date {
  const n = Math.max(1, consecutiveErrors);
  const days = Math.min(ERROR_BACKOFF_CAP_DAYS, ERROR_BACKOFF_BASE_DAYS * 2 ** (n - 1));
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Milliseconds until `needed` tokens are available. Zero with headroom, or when the
 * balance is unknown (the first request after boot reveals it).
 */
export function msUntilTokens(tokensLeft: number | null, refillRatePerMin: number | null, needed: number): number {
  if (tokensLeft === null || tokensLeft >= needed) return 0;
  const rate = refillRatePerMin && refillRatePerMin > 0 ? refillRatePerMin : DEFAULT_REFILL_RATE_PER_MIN;
  return Math.ceil(((needed - tokensLeft) / rate) * 60_000);
}
