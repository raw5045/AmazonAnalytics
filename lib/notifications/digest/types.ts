// lib/notifications/digest/types.ts
/**
 * Shared types for the weekly digest. Kept in one place so the builder,
 * loaders, and send engine all reference identical shapes.
 */

export type DigestVariant = 'watchlist' | 'broadcast';

/** A user eligible to receive the digest, with enough info to pick a variant. */
export interface DigestRecipient {
  userId: string;
  email: string;
  watchlistCount: number;
}

/** One watched keyword's current-week metrics, as rendered in the email table. */
export interface DigestKeywordRow {
  searchTermId: string;
  searchTermRaw: string;
  currentRank: number | null;
  priorWeekRank: number | null;
  rank4wAgo: number | null;
  improvement1w: number | null;   // prior_week_rank - current_rank; positive = improvement
  estMonthlyVolume: number | null;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}
