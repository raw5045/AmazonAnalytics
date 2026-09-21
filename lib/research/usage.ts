import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { bumpUserActivityBy } from '@/lib/activity/bump';
import { ResearchError } from './errors';
import type { ResearchLimits } from './limits';

/** Floors `d` to the start of its UTC minute — the key of the per-minute usage bucket it falls in. */
export function minuteFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

export interface ReserveArgs {
  userId: string;
  channel: 'mcp';
  /**
   * Rows this call is asking to reserve: the requested page size (search), weeks
   * (history), 1 (details), or 0 (guide/resolve). This is what the call asks for up
   * front, reserved before any work runs — not what it ends up delivering. The
   * delivered count (which can be smaller than reserved, e.g. a capped or
   * payload-shrunk search page) is reported separately, after the fact, to
   * `recordMcpActivity`.
   */
  rows: number;
  /** Injected by the service (never read from `new Date()` in here), so a caller controls the bucket and the retry-after math precisely. */
  now: Date;
  limits: ResearchLimits;
}
export interface ReserveResult {
  requests: number;
  rows: number;
}

/**
 * One atomic upsert per request (amendment §6): counts the request and
 * reserves `rows` (the requested page size) in this minute's bucket. Over
 * either limit → RATE_LIMITED with the seconds left in the minute. The
 * increment still lands, so a burst cannot overshoot by racing.
 *
 * The over-limit check is "over EITHER limit" — literally as the spec states it, not
 * "over the limit this call's own `rows` actually touches". So a `rows: 0` call
 * (guide/resolve) still only adds to the rows bucket by zero, but is refused all the
 * same when that minute's rows bucket is already over its limit from earlier calls:
 * a free call cannot buy its way past an already-blown rows budget. Deliberate, not
 * an oversight.
 */
export async function reserveResearchRequest(args: ReserveArgs): Promise<ReserveResult> {
  if (!Number.isSafeInteger(args.rows) || args.rows < 0) {
    throw new Error(`reserveResearchRequest: rows must be a non-negative safe integer, got ${args.rows}`);
  }
  const bucket = minuteFloor(args.now);
  const result = await db.execute<{ requests: number; rows: number }>(sql`
    INSERT INTO research_usage_buckets (user_id, channel, bucket_start, requests, "rows")
    VALUES (${args.userId}::uuid, ${args.channel}, ${bucket.toISOString()}::timestamptz, 1, ${args.rows})
    ON CONFLICT (user_id, channel, bucket_start) DO UPDATE
      SET requests = research_usage_buckets.requests + 1,
          "rows" = research_usage_buckets."rows" + EXCLUDED."rows"
    RETURNING requests, "rows"
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error('reserveResearchRequest: upsert returned no row');
  }
  if (row.requests > args.limits.requestsPerMinute || row.rows > args.limits.rowsPerMinute) {
    // defensive: bucket <= args.now by construction (bucket = minuteFloor(args.now)), so
    // bucket.getTime() + 60_000 - args.now.getTime() is already in (0, 60_000] and the ceil()
    // below is already in [1, 60] — Math.max(1, …) only guards against that invariant ever
    // not holding (e.g. a future caller passing a `now` that disagrees with the bucket it floors to).
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.getTime() + 60_000 - args.now.getTime()) / 1000));
    throw new ResearchError(
      'RATE_LIMITED',
      `Rate limit reached (${args.limits.requestsPerMinute} requests or ${args.limits.rowsPerMinute} rows per minute per account). Try again in ${retryAfterSeconds} seconds.`,
      { retryable: true, retryAfterSeconds },
    );
  }
  return { requests: row.requests, rows: row.rows };
}

/** Daily digest counters; fire-and-forget. */
export function recordMcpActivity(userId: string, rowsReturned: number): void {
  void bumpUserActivityBy(userId, 'mcp_request', 1);
  if (rowsReturned > 0) void bumpUserActivityBy(userId, 'mcp_rows', rowsReturned);
}
