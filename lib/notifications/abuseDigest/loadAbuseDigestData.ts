// lib/notifications/abuseDigest/loadAbuseDigestData.ts
//
// IMPORTANT: do NOT add `import 'server-only'` here. This module is pulled
// into the Railway worker's import graph via sendAbuseDigest.ts (the worker
// runs plain Node via tsx). See the matching note in
// lib/notifications/digest/loadDigestData.ts.
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
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
import { assemblePerUserActivity, type CounterRow, type UserInfo } from './assembleStats';
import type { AbuseDigestStats, SignupRow } from './types';

const SIGNIN_EMAILS_CAP = 10;

// Compile-time tether to the writer's metric names (lib/activity/bump.ts) —
// a rename on either side becomes a type error instead of silent zeros.
const CONTACT_METRICS = {
  submissions: 'contact_submission',
  honeypotTrips: 'contact_honeypot',
} satisfies Record<string, AppActivityMetric>;

/**
 * Load everything the digest reports for one ET calendar day (YYYY-MM-DD).
 *
 * timestamptz columns (created_at / added_at / last_login_at) are filtered
 * with the half-open window [day 00:00 ET, day+1 00:00 ET): Postgres's
 * `naive_ts AT TIME ZONE 'America/New_York'` interprets the naive timestamp
 * as ET wall time and yields the correct UTC instant across DST changes.
 * Counter tables carry the ET day directly in their `day` column.
 */
export async function loadAbuseDigestData(day: string): Promise<AbuseDigestStats> {
  const dayStart = sql`((${day})::date)::timestamp AT TIME ZONE 'America/New_York'`;
  const dayEnd = sql`(((${day})::date + 1))::timestamp AT TIME ZONE 'America/New_York'`;

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

  // 2. Per-user read counters for the day. The PK (user_id, day, metric)
  //    guarantees ≤1 row per (user, metric) here — assemblePerUserActivity
  //    assigns (not accumulates) on that invariant.
  const counters: CounterRow[] = await db
    .select({
      userId: userActivityDaily.userId,
      metric: userActivityDaily.metric,
      count: userActivityDaily.count,
    })
    .from(userActivityDaily)
    .where(eq(userActivityDaily.day, day));

  // 3. Same-day creations, grouped per user.
  const watchlistRows = await db
    .select({ userId: watchlistItems.userId, n: sql<number>`count(*)::int` })
    .from(watchlistItems)
    .where(and(gte(watchlistItems.addedAt, dayStart), lt(watchlistItems.addedAt, dayEnd)))
    .groupBy(watchlistItems.userId);
  const savedViewRows = await db
    .select({ userId: savedViews.userId, n: sql<number>`count(*)::int` })
    .from(savedViews)
    .where(and(gte(savedViews.createdAt, dayStart), lt(savedViews.createdAt, dayEnd)))
    .groupBy(savedViews.userId);
  const categoryRows = await db
    .select({ userId: customCategories.userId, n: sql<number>`count(*)::int` })
    .from(customCategories)
    .where(and(gte(customCategories.createdAt, dayStart), lt(customCategories.createdAt, dayEnd)))
    .groupBy(customCategories.userId);

  // 4. Identity for every user involved.
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

  const activeUsers = assemblePerUserActivity(
    counters,
    {
      watchlistAdds: new Map(watchlistRows.map((r) => [r.userId, r.n])),
      savedViewsCreated: new Map(savedViewRows.map((r) => [r.userId, r.n])),
      customCategoriesCreated: new Map(categoryRows.map((r) => [r.userId, r.n])),
    },
    userInfo,
  );

  // 5. Sign-ins (supplementary; latest-stamp only — see spec).
  const signInRows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(gte(users.lastLoginAt, dayStart), lt(users.lastLoginAt, dayEnd)))
    .orderBy(desc(users.lastLoginAt));
  const signIns = {
    count: signInRows.length,
    emails: signInRows.slice(0, SIGNIN_EMAILS_CAP).map((r) => r.email),
  };

  // 6. App-wide contact counters.
  const appRows = await db
    .select({ metric: appActivityDaily.metric, count: appActivityDaily.count })
    .from(appActivityDaily)
    .where(eq(appActivityDaily.day, day));
  const contact = {
    submissions: appRows.find((r) => r.metric === CONTACT_METRICS.submissions)?.count ?? 0,
    honeypotTrips: appRows.find((r) => r.metric === CONTACT_METRICS.honeypotTrips)?.count ?? 0,
  };

  return { day, totalUsers, signups, activeUsers, signIns, contact };
}
