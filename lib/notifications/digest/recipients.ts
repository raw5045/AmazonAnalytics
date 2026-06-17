// lib/notifications/digest/recipients.ts
import type { DigestVariant } from './types';

/**
 * True when an address cannot be delivered to and must be excluded from a
 * digest send. Covers the RFC 2606 / 6761 reserved domains that providers
 * (Resend) hard-reject — example.com/net/org, the .invalid/.test/.example/
 * .localhost TLDs, and bare localhost — plus malformed addresses.
 *
 * WHY: new users default to digest-subscribed, and integration tests create
 * users with reserved-domain emails. Resend's batch send is atomic, so ONE
 * such address rejects the entire batch and fails the whole run. Filtering
 * these out of the recipient set keeps the digest immune to that. (Real
 * domains used by throwaway test accounts — e.g. x.com — are NOT caught here;
 * those are handled by unsubscribing the accounts.)
 */
export function isUndeliverableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  // Need a non-empty local part AND a non-empty domain.
  if (at < 1 || at === email.length - 1) return true;
  const domain = email.slice(at + 1).toLowerCase();
  if (domain === 'example.com' || domain === 'example.net' || domain === 'example.org') return true;
  if (domain === 'localhost') return true;
  return /\.(invalid|test|example|localhost)$/.test(domain);
}

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
