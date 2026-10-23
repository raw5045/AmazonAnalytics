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
  /** MCP calls (mcp_request counter): +1 per research or workspace call completed, writes included (so mcpWrites is a subset) — see recordResearchActivity in lib/research/usage.ts. Refused (rate-limited, invalid) or failed calls are not counted; whoami is never counted. */
  mcpRequests: number;
  /** Rows returned by MCP tools (mcp_rows counter). */
  mcpRows: number;
  /** Workspace writes through the MCP (mcp_write counter): saved views, custom categories and watchlist changes, +1 per successful call. Capped at 200/day by default (overridable through RESEARCH_LIMITS_JSON; spec 2026-09-30 §8.2). */
  mcpWrites: number;
  /** Products list renders (products_query counter): one per render, each runs a search (spec 2026-10-23 §4). */
  productsQueries: number;
  /** Product page renders (product_view counter; spec 2026-10-23 §4). */
  productViews: number;
}

/** Per-user activity over a trailing window of ET days (inclusive bounds). */
export interface ActiveUsersWindow {
  /** First ET day in the window, YYYY-MM-DD. */
  startDay: string;
  /** Last ET day in the window (the digest day), YYYY-MM-DD. */
  endDay: string;
  /** One row per user active anywhere in the window, sorted by reads (queries + detail views + product searches + product views + MCP calls) desc. */
  users: PerUserActivity[];
}

/**
 * The digest day's slow or timed-out product searches (slow_queries rows with surface 'products', the Products list,
 * or 'products_tool', the search_products tool from an AI client or Ask AI; spec 2026-10-23 §5b): timeouts (the 30 s
 * statement cap) and completed-but-slow runs counted apart over both surfaces, then the most frequent filter
 * combinations.
 */
export interface SlowSearchesSummary {
  timeouts: number;
  slow: number;
  /** How many of the day's rows (timeouts and slow runs alike) came from the search_products tool. */
  viaToolTotal: number;
  /**
   * The top query strings by occurrences (at most ten; ties by the string), each with its distinct-account count and
   * `viaTool`, how many of its occurrences came from the search_products tool (0 when all came from the Products list).
   */
  top: Array<{ queryString: string; occurrences: number; accounts: number; viaTool: number }>;
}

export interface AbuseDigestStats {
  /** ET calendar day this digest covers, YYYY-MM-DD */
  day: string;
  totalUsers: number;
  signups: SignupRow[];
  /** One row per active user on `day`, sorted by reads (queries + detail views + product searches + product views + MCP calls) desc. */
  activeUsers: PerUserActivity[];
  /** Trailing 7 ET days ending on `day` (same columns, counters summed across the window). */
  weeklyActiveUsers: ActiveUsersWindow;
  /** Trailing 30 ET days ending on `day`. */
  monthlyActiveUsers: ActiveUsersWindow;
  signIns: { count: number; emails: string[] };
  contact: { submissions: number; honeypotTrips: number };
  /** Slow and timed-out product searches on `day`. */
  slowSearches: SlowSearchesSummary;
}

export interface Flag {
  severity: 'amber' | 'red';
  message: string;
}
