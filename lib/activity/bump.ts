/**
 * Fire-and-forget daily activity counters (admin abuse-digest source data).
 *
 * CONTRACT: callers invoke these UN-AWAITED (`void bumpUserActivity(...)`)
 * from hot request paths. Every error is swallowed to a console.warn of
 * coded fields only (warnBumpFailed) — a lost count is acceptable; a slowed
 * or crashed request is not. (On Vercel,
 * the function freeze after a response can also occasionally drop an
 * in-flight bump — same accepted trade.)
 *
 * No `import 'server-only'` — keep this importable everywhere.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { userActivityDaily, appActivityDaily } from '@/db/schema';
import { errFields } from '@/lib/ask/logSafe';
import { etDay } from './etDay';

/**
 * The one warn line for a failed bump, coded fields only: a DrizzleQueryError's own message embeds the statement and
 * its bound params (the account id among them), so neither it nor errFields' `detail` (the message) is logged.
 */
function warnBumpFailed(fn: 'bumpUserActivity' | 'bumpUserActivityBy' | 'bumpAppActivity', metric: string, e: unknown): void {
  const { error, code } = errFields(e);
  console.warn(`[activity] ${fn} failed`, JSON.stringify({ metric, error, code }));
}

export type UserActivityMetric =
  | 'explorer_query'
  | 'detail_view'
  | 'explorer_export'
  | 'mcp_request'
  | 'mcp_rows'
  | 'ask_question'
  | 'ask_tool_call'
  | 'ask_rows'
  /** One successful workspace write through the MCP (spec 2026-09-30 §8.2); the daily cap reads it back with countUserActivityToday. */
  | 'mcp_write'
  /** One per Products list render that runs a search (spec 2026-10-23 §4). */
  | 'products_query'
  /** One per product page render (spec 2026-10-23 §4). */
  | 'product_view';
export type AppActivityMetric = 'contact_submission' | 'contact_honeypot' | 'feedback_submission';

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
    warnBumpFailed('bumpUserActivity', metric, e);
  }
}

/**
 * Increment-by-N variant (MCP or chat rows per page); same fire-and-forget contract as
 * bumpUserActivity. A non-integer `by` (NaN, Infinity, a fractional or unsafe value) is a
 * programmer error — it's warned so it isn't silently lost — and is never written. `by <= 0`
 * (zero or negative, but a legitimate integer) stays silently ignored: a page that returned
 * no rows is not a bug.
 */
export async function bumpUserActivityBy(userId: string, metric: UserActivityMetric, by: number): Promise<void> {
  if (!Number.isSafeInteger(by)) {
    console.warn(`[activity] bumpUserActivityBy(${metric}) called with a non-integer by=${by}; ignoring`);
    return;
  }
  if (by <= 0) return;
  try {
    await db
      .insert(userActivityDaily)
      .values({ userId, day: etDay(new Date()), metric, count: by })
      .onConflictDoUpdate({
        target: [userActivityDaily.userId, userActivityDaily.day, userActivityDaily.metric],
        set: { count: sql`${userActivityDaily.count} + ${by}` },
      });
  } catch (e) {
    warnBumpFailed('bumpUserActivityBy', metric, e);
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
    warnBumpFailed('bumpAppActivity', metric, e);
  }
}
