// lib/notifications/abuseDigest/types.ts
// Shared shapes for the daily admin abuse-digest. See
// docs/superpowers/specs/2026-07-13-abuse-digest-design.md.

export interface SignupRow {
  email: string;
  name: string | null;
  /** ISO timestamp of users.created_at */
  createdAt: string;
}

export interface PerUserActivity {
  userId: string;
  email: string;
  name: string | null;
  explorerQueries: number;
  detailViews: number;
  watchlistAdds: number;
  savedViewsCreated: number;
  customCategoriesCreated: number;
}

export interface AbuseDigestStats {
  /** ET calendar day this digest covers, YYYY-MM-DD */
  day: string;
  totalUsers: number;
  signups: SignupRow[];
  /** One row per active user, sorted by reads (queries + detail views) desc. */
  activeUsers: PerUserActivity[];
  signIns: { count: number; emails: string[] };
  contact: { submissions: number; honeypotTrips: number };
}

export interface Flag {
  severity: 'amber' | 'red';
  message: string;
}
