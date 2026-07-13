// lib/notifications/abuseDigest/evaluateFlags.ts
// Pure threshold evaluation. This module is the single tuning point for
// what the digest flags — and the seam a future intra-day tripwire would
// reuse unchanged (deferred v2; see the spec's non-goals).
import type { AbuseDigestStats, Flag } from './types';

/**
 * V1 thresholds are deliberate GUESSES (2026-07-13, pre-launch traffic ≈
 * two known users). Tune against real digest data; all comparisons are
 * strictly greater-than.
 */
export const THRESHOLDS = {
  signupsPerDay: { amber: 10, red: 25 },
  userReadsPerDay: { amber: 500, red: 2000 }, // explorer queries + detail views
  userWatchlistAddsPerDay: { amber: 100, red: 500 },
  userSavedViewsPerDay: { amber: 15 },
  userCustomCategoriesPerDay: { amber: 10 },
  honeypotTripsPerDay: { amber: 20 },
  contactSubmissionsPerDay: { amber: 10 },
} as const;

export function evaluateFlags(stats: AbuseDigestStats): Flag[] {
  const flags: Flag[] = [];

  const banded = (
    value: number,
    t: { amber: number; red?: number },
    label: (v: number, threshold: number, sev: 'amber' | 'red') => string,
  ) => {
    if (t.red !== undefined && value > t.red) {
      flags.push({ severity: 'red', message: label(value, t.red, 'red') });
    } else if (value > t.amber) {
      flags.push({ severity: 'amber', message: label(value, t.amber, 'amber') });
    }
  };

  banded(stats.signups.length, THRESHOLDS.signupsPerDay, (v, th, sev) =>
    `${v} signups yesterday (${sev} threshold: ${th})`,
  );

  for (const u of stats.activeUsers) {
    banded(u.explorerQueries + u.detailViews, THRESHOLDS.userReadsPerDay, (v, th, sev) =>
      `${u.email}: ${v} reads (${sev} threshold: ${th})`,
    );
    banded(u.watchlistAdds, THRESHOLDS.userWatchlistAddsPerDay, (v, th, sev) =>
      `${u.email}: ${v} watchlist adds (${sev} threshold: ${th})`,
    );
    banded(u.savedViewsCreated, THRESHOLDS.userSavedViewsPerDay, (v, th, sev) =>
      `${u.email}: ${v} saved views created (${sev} threshold: ${th})`,
    );
    banded(u.customCategoriesCreated, THRESHOLDS.userCustomCategoriesPerDay, (v, th, sev) =>
      `${u.email}: ${v} custom categories created (${sev} threshold: ${th})`,
    );
  }

  banded(stats.contact.honeypotTrips, THRESHOLDS.honeypotTripsPerDay, (v, th, sev) =>
    `${v} honeypot trips yesterday (${sev} threshold: ${th})`,
  );
  banded(stats.contact.submissions, THRESHOLDS.contactSubmissionsPerDay, (v, th, sev) =>
    `${v} contact submissions yesterday (${sev} threshold: ${th})`,
  );

  // Red first so the worst news leads the email.
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
}
