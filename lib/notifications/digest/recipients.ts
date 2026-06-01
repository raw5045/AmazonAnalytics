// lib/notifications/digest/recipients.ts
import type { DigestVariant } from './types';

/** Watchlist variant iff the user watches at least one keyword. */
export function variantFor(watchlistCount: number): DigestVariant {
  return watchlistCount > 0 ? 'watchlist' : 'broadcast';
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Roll the per-user send outcome counts up to a run-level status.
 * Zero recipients (or all-sent) → 'sent'; mixed → 'sent_with_failures';
 * all-failed → 'failed'.
 */
export function rollupRunStatus(counts: { sent: number; failed: number }):
  | 'sent'
  | 'sent_with_failures'
  | 'failed' {
  if (counts.failed === 0) return 'sent';
  if (counts.sent === 0) return 'failed';
  return 'sent_with_failures';
}
