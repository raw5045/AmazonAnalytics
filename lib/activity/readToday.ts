import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { userActivityDaily } from '@/db/schema';
import { etDay } from './etDay';
import type { UserActivityMetric } from './bump';

/**
 * Today's (ET calendar day) counter for one user + metric, 0 when no row
 * exists yet. Used for soft daily caps (e.g. explorer exports). Unlike the
 * fire-and-forget writers in bump.ts this is awaited on the request path, so
 * errors propagate and the caller decides how to fail.
 */
export async function countUserActivityToday(userId: string, metric: UserActivityMetric): Promise<number> {
  const rows = await db
    .select({ count: userActivityDaily.count })
    .from(userActivityDaily)
    .where(
      and(
        eq(userActivityDaily.userId, userId),
        eq(userActivityDaily.day, etDay(new Date())),
        eq(userActivityDaily.metric, metric),
      ),
    );
  return rows[0]?.count ?? 0;
}
