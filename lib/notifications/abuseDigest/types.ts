// lib/notifications/abuseDigest/types.ts
// Shared shapes for the daily admin abuse-digest. See
// docs/superpowers/specs/2026-07-13-abuse-digest-design.md and, for the
// weekly/monthly windows, 2026-09-15-digest-active-user-windows-design.md.

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
  /** CSV exports (explorer_export counter) — capped at 10/day by the route. */
  exports: number;
  /** MCP research calls (mcp_request counter): +1 per tool call the research service completed — see recordMcpActivity in lib/research/usage.ts. Refused (rate-limited, invalid) or failed calls are not counted; whoami is never counted. */
  mcpRequests: number;
  /** Rows returned by MCP tools (mcp_rows counter). */
  mcpRows: number;
}

/** Per-user activity over a trailing window of ET days (inclusive bounds). */
export interface ActiveUsersWindow {
  /** First ET day in the window, YYYY-MM-DD. */
  startDay: string;
  /** Last ET day in the window (the digest day), YYYY-MM-DD. */
  endDay: string;
  /** One row per user active anywhere in the window, sorted by reads (queries + detail views + MCP calls) desc. */
  users: PerUserActivity[];
}

export interface AbuseDigestStats {
  /** ET calendar day this digest covers, YYYY-MM-DD */
  day: string;
  totalUsers: number;
  signups: SignupRow[];
  /** One row per active user on `day`, sorted by reads (queries + detail views + MCP calls) desc. */
  activeUsers: PerUserActivity[];
  /** Trailing 7 ET days ending on `day` (same columns, counters summed across the window). */
  weeklyActiveUsers: ActiveUsersWindow;
  /** Trailing 30 ET days ending on `day`. */
  monthlyActiveUsers: ActiveUsersWindow;
  signIns: { count: number; emails: string[] };
  contact: { submissions: number; honeypotTrips: number };
}

export interface Flag {
  severity: 'amber' | 'red';
  message: string;
}
