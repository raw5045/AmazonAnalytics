// lib/notifications/abuseDigest/loadAbuseDigestData.ts
//
// IMPORTANT: do NOT add `import 'server-only'` here. This module is pulled
// into the Railway worker's import graph via sendAbuseDigest.ts (the worker
// runs plain Node via tsx). See the matching note in
// lib/notifications/digest/loadDigestData.ts.
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  watchlistItems,
  savedViews,
  customCategories,
  userActivityDaily,
  appActivityDaily,
} from '@/db/schema';
import type { AppActivityMetric } from '@/lib/activity/bump';
import { addDays } from '@/lib/activity/etDay';
import { assemblePerUserActivity, type CounterRow, type UserInfo } from './assembleStats';
import type { AbuseDigestStats, ActiveUsersWindow, PerUserActivity, SignupRow } from './types';

const SIGNIN_EMAILS_CAP = 10;
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
 * used to filter timestamptz columns (created_at / added_at / last_login_at).
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
 * 7- and 30-day windows ending on it, sign-ins, and contact counters.
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

  // 3. Sign-ins (supplementary; latest-stamp only — see spec).
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

  return { day, totalUsers, signups, activeUsers, weeklyActiveUsers, monthlyActiveUsers, signIns, contact };
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
