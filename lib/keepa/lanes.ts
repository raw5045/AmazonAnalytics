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
/** Assumed until Keepa reports the rate (the subscription's rate per the free /token call, 2026-10-05). */
export const DEFAULT_REFILL_RATE_PER_MIN = 250;
/**
 * Tokens left in the bucket after each batch, for the old import-time job's one-token calls during
 * the shadow week (it has no 429 handling). A constant offset, so throughput is unchanged.
 */
export const TOKEN_RESERVE = 50;
/** A paced request fires this long after Keepa's announced refill, so it lands after it. */
export const REFILL_MARGIN_MS = 500;
/**
 * Postgres advisory-lock key shared by the enqueue-week upsert (exclusive) and the service's
 * batch writes (shared): the upsert holds row locks on ~2.3M rows for minutes, in a different
 * order than the batch writes, so without this handshake the two would deadlock.
 */
export const ENQUEUE_LOCK_KEY = 20261005;

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
 * Milliseconds until `needed` tokens are available. Zero with headroom, or when the balance is
 * unknown (the first request after boot reveals it). Keepa refills the bucket in one step a minute
 * (`refillInMs` = ms until the next +rate): with that known, wait for as many refills as the
 * shortfall takes, plus REFILL_MARGIN_MS. Without it (or a negative one), estimate a continuous
 * trickle at the rate.
 */
export function msUntilTokens(tokensLeft: number | null, refillRatePerMin: number | null, needed: number, refillInMs: number | null): number {
  if (tokensLeft === null || tokensLeft >= needed) return 0;
  const rate = refillRatePerMin && refillRatePerMin > 0 ? refillRatePerMin : DEFAULT_REFILL_RATE_PER_MIN;
  const deficit = needed - tokensLeft;
  if (refillInMs === null || refillInMs < 0) return Math.ceil((deficit / rate) * 60_000);
  const refills = Math.ceil(deficit / rate);
  return refillInMs + (refills - 1) * 60_000 + REFILL_MARGIN_MS;
}
