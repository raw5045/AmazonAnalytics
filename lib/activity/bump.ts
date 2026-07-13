/**
 * Fire-and-forget daily activity counters (admin abuse-digest source data).
 *
 * CONTRACT: callers invoke these UN-AWAITED (`void bumpUserActivity(...)`)
 * from hot request paths. Every error is swallowed to a console.warn — a
 * lost count is acceptable; a slowed or crashed request is not. (On Vercel,
 * the function freeze after a response can also occasionally drop an
 * in-flight bump — same accepted trade.)
 *
 * No `import 'server-only'` — keep this importable everywhere.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { userActivityDaily, appActivityDaily } from '@/db/schema';
import { etDay } from './etDay';

export type UserActivityMetric = 'explorer_query' | 'detail_view';
export type AppActivityMetric = 'contact_submission' | 'contact_honeypot';

export async function bumpUserActivity(userId: string, metric: UserActivityMetric): Promise<void> {
  try {
    await db
      .insert(userActivityDaily)
      .values({ userId, day: etDay(new Date()), metric, count: 1 })
      .onConflictDoUpdate({
        target: [userActivityDaily.userId, userActivityDaily.day, userActivityDaily.metric],
        set: { count: sql`${userActivityDaily.count} + 1` },
      });
  } catch (e) {
    console.warn(`[activity] bumpUserActivity(${metric}) failed:`, e instanceof Error ? e.message : e);
  }
}

export async function bumpAppActivity(metric: AppActivityMetric): Promise<void> {
  try {
    await db
      .insert(appActivityDaily)
      .values({ day: etDay(new Date()), metric, count: 1 })
      .onConflictDoUpdate({
        target: [appActivityDaily.day, appActivityDaily.metric],
        set: { count: sql`${appActivityDaily.count} + 1` },
      });
  } catch (e) {
    console.warn(`[activity] bumpAppActivity(${metric}) failed:`, e instanceof Error ? e.message : e);
  }
}
