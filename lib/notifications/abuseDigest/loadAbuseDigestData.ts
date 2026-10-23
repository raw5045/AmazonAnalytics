// lib/notifications/abuseDigest/loadAbuseDigestData.ts
//
// IMPORTANT: do NOT add `import 'server-only'` here. This module is pulled
// into the Railway worker's import graph via sendAbuseDigest.ts (the worker
// runs plain Node via tsx). See the matching note in
// lib/notifications/digest/loadDigestData.ts.
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  watchlistItems,
  savedViews,
  customCategories,
  userActivityDaily,
  appActivityDaily,
  slowQueries,
} from '@/db/schema';
import type { AppActivityMetric } from '@/lib/activity/bump';
import { addDays } from '@/lib/activity/etDay';
import type { SlowQuerySurface } from '@/lib/products/slowQueries';
import { assemblePerUserActivity, type CounterRow, type UserInfo } from './assembleStats';
import { SLOW_SEARCH_ROW_CAP } from './buildAbuseDigestEmail';
import type { AbuseDigestStats, ActiveUsersWindow, PerUserActivity, SignupRow, SlowSearchesSummary } from './types';

const SIGNIN_EMAILS_CAP = 10;
/**
 * The slow_queries surfaces a product search records under (lib/products/slowQueries.ts): the Products list, and the
 * search_products tool (an AI client over the MCP, or Ask AI). Tethered to the writer's type, as CONTACT_METRICS below is
 * to its metric names: a renamed surface is a type error, not a section that silently reads nothing.
 */
const PRODUCT_SEARCH_SURFACES = ['products', 'products_tool'] as const satisfies readonly SlowQuerySurface[];
/** The tool's surface: its rows are counted apart per query string (viaTool). */
const PRODUCTS_TOOL_SURFACE = 'products_tool' satisfies SlowQuerySurface;
/** Trailing windows for the weekly/monthly sections, inclusive of the digest day. */
export const WEEKLY_WINDOW_DAYS = 7;
export const MONTHLY_WINDOW_DAYS = 30;

// Compile-time tether to the writer's metric names (lib/activity/bump.ts) —
// a rename on either side becomes a type error instead of silent zeros.
const CONTACT_METRICS = {
  submissions: 'contact_submission',
  honeypotTrips: 'contact_honeypot',
} satisfies Record<string, AppActivityMetric>;

/**
 * UTC instants for the half-open window [startDay 00:00 ET, endDay+1 00:00 ET)
 * used to filter timestamptz columns (created_at / added_at / last_login_at /
 * happened_at).
 * Postgres's `naive_ts AT TIME ZONE 'America/New_York'` interprets the naive
 * timestamp as ET wall time and yields the correct UTC instant across DST
 * changes. Counter tables carry the ET day directly in their `day` column.
 */
function etWindowBounds(startDay: string, endDay: string) {
  return {
    start: sql`((${startDay})::date)::timestamp AT TIME ZONE 'America/New_York'`,
    end: sql`(((${endDay})::date + 1))::timestamp AT TIME ZONE 'America/New_York'`,
  };
}

/**
 * Load everything the digest reports for one ET calendar day (YYYY-MM-DD):
 * the day's signups, per-user activity for the day and for the trailing
 * 7- and 30-day windows ending on it, sign-ins, contact counters, and the
 * slow product searches.
 */
export async function loadAbuseDigestData(day: string): Promise<AbuseDigestStats> {
  const { start: dayStart, end: dayEnd } = etWindowBounds(day, day);

  // 1. Signups + total users.
  const signupRows = await db
    .select({ email: users.email, name: users.name, createdAt: users.createdAt })
    .from(users)
    .where(and(gte(users.createdAt, dayStart), lt(users.createdAt, dayEnd)))
    .orderBy(asc(users.createdAt));
  const signups: SignupRow[] = signupRows.map((r) => ({
    email: r.email,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
  }));

  const [{ totalUsers }] = await db
    .select({ totalUsers: sql<number>`count(*)::int` })
    .from(users);

  // 2. Per-user activity: the digest day, then the trailing windows that end on it.
  const activeUsers = await loadActiveUsersForWindow(day, day);
  const weeklyActiveUsers = await loadWindow(addDays(day, -(WEEKLY_WINDOW_DAYS - 1)), day);
  const monthlyActiveUsers = await loadWindow(addDays(day, -(MONTHLY_WINDOW_DAYS - 1)), day);

  // 3. Sign-ins (supplementary; latest-stamp only — see spec). Since
  //    2026-09-16 syncUserFromClerk also stamps last_login_at when it creates
  //    a row (signup = sign-in), so a member's signup day always counts even
  //    when the session.created webhook beat the row.
  const signInRows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(gte(users.lastLoginAt, dayStart), lt(users.lastLoginAt, dayEnd)))
    .orderBy(desc(users.lastLoginAt));
  const signIns = {
    count: signInRows.length,
    emails: signInRows.slice(0, SIGNIN_EMAILS_CAP).map((r) => r.email),
  };

  // 4. App-wide contact counters.
  const appRows = await db
    .select({ metric: appActivityDaily.metric, count: appActivityDaily.count })
    .from(appActivityDaily)
    .where(eq(appActivityDaily.day, day));
  const contact = {
    submissions: appRows.find((r) => r.metric === CONTACT_METRICS.submissions)?.count ?? 0,
    honeypotTrips: appRows.find((r) => r.metric === CONTACT_METRICS.honeypotTrips)?.count ?? 0,
  };

  // 5. Slow and timed-out product searches, over the same ET-day bounds.
  const slowSearches = await loadSlowSearches(dayStart, dayEnd);

  return { day, totalUsers, signups, activeUsers, weeklyActiveUsers, monthlyActiveUsers, signIns, contact, slowSearches };
}

/**
 * The day's slow_queries rows of a product search, from the Products list and from the search_products tool (spec
 * 2026-10-23 §5b), read through the (surface, happened_at) index: timeouts and completed-but-slow runs counted apart over
 * both surfaces, with the tool's share of all of them (viaToolTotal), then the SLOW_SEARCH_ROW_CAP most frequent query
 * strings (ties by the string) with their occurrences, their distinct accounts (a null user_id, an unknown account, is
 * not counted as one) and how many of the occurrences came from the tool (viaTool).
 */
async function loadSlowSearches(start: SQL, end: SQL): Promise<SlowSearchesSummary> {
  const inDay = and(inArray(slowQueries.surface, PRODUCT_SEARCH_SURFACES), gte(slowQueries.happenedAt, start), lt(slowQueries.happenedAt, end));
  // An aggregate without GROUP BY always returns its one row; the fallback only keeps the type honest.
  const [counts] = await db
    .select({
      timeouts: sql<number>`(count(*) filter (where ${slowQueries.timedOut}))::int`,
      slow: sql<number>`(count(*) filter (where not ${slowQueries.timedOut}))::int`,
      viaToolTotal: sql<number>`(count(*) filter (where ${slowQueries.surface} = ${PRODUCTS_TOOL_SURFACE}))::int`,
    })
    .from(slowQueries)
    .where(inDay);
  const top = await db
    .select({
      queryString: slowQueries.queryString,
      occurrences: sql<number>`count(*)::int`,
      accounts: sql<number>`count(distinct ${slowQueries.userId})::int`,
      viaTool: sql<number>`(count(*) filter (where ${slowQueries.surface} = ${PRODUCTS_TOOL_SURFACE}))::int`,
    })
    .from(slowQueries)
    .where(inDay)
    .groupBy(slowQueries.queryString)
    .orderBy(desc(sql`count(*)`), asc(slowQueries.queryString))
    .limit(SLOW_SEARCH_ROW_CAP);
  return { timeouts: counts?.timeouts ?? 0, slow: counts?.slow ?? 0, viaToolTotal: counts?.viaToolTotal ?? 0, top };
}

async function loadWindow(startDay: string, endDay: string): Promise<ActiveUsersWindow> {
  return { startDay, endDay, users: await loadActiveUsersForWindow(startDay, endDay) };
}

/**
 * Per-user activity over the inclusive ET-day window [startDay, endDay].
 * Counters are SUMmed per (user, metric) so assemblePerUserActivity's
 * one-row-per-(user, metric) invariant holds for any window width; a one-day
 * window reproduces the original per-day digest exactly (a SUM over one row
 * is that row's count). Creations are COUNTed over the matching timestamp
 * window.
 */
async function loadActiveUsersForWindow(startDay: string, endDay: string): Promise<PerUserActivity[]> {
  const { start, end } = etWindowBounds(startDay, endDay);

  const counters: CounterRow[] = await db
    .select({
      userId: userActivityDaily.userId,
      metric: userActivityDaily.metric,
      count: sql<number>`sum(${userActivityDaily.count})::int`,
    })
    .from(userActivityDaily)
    .where(and(gte(userActivityDaily.day, startDay), lte(userActivityDaily.day, endDay)))
    .groupBy(userActivityDaily.userId, userActivityDaily.metric);

  const watchlistRows = await db
    .select({ userId: watchlistItems.userId, n: sql<number>`count(*)::int` })
    .from(watchlistItems)
    .where(and(gte(watchlistItems.addedAt, start), lt(watchlistItems.addedAt, end)))
    .groupBy(watchlistItems.userId);
  const savedViewRows = await db
    .select({ userId: savedViews.userId, n: sql<number>`count(*)::int` })
    .from(savedViews)
    .where(and(gte(savedViews.createdAt, start), lt(savedViews.createdAt, end)))
    .groupBy(savedViews.userId);
  const categoryRows = await db
    .select({ userId: customCategories.userId, n: sql<number>`count(*)::int` })
    .from(customCategories)
    .where(and(gte(customCategories.createdAt, start), lt(customCategories.createdAt, end)))
    .groupBy(customCategories.userId);

  // Identity for every user involved.
  const involvedIds = [
    ...new Set([
      ...counters.map((c) => c.userId),
      ...watchlistRows.map((r) => r.userId),
      ...savedViewRows.map((r) => r.userId),
      ...categoryRows.map((r) => r.userId),
    ]),
  ];
  const userInfo = new Map<string, UserInfo>();
  if (involvedIds.length > 0) {
    const infoRows = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, involvedIds));
    for (const r of infoRows) userInfo.set(r.id, { email: r.email, name: r.name });
  }

  return assemblePerUserActivity(
    counters,
    {
      watchlistAdds: new Map(watchlistRows.map((r) => [r.userId, r.n])),
      savedViewsCreated: new Map(savedViewRows.map((r) => [r.userId, r.n])),
      customCategoriesCreated: new Map(categoryRows.map((r) => [r.userId, r.n])),
    },
    userInfo,
  );
}
