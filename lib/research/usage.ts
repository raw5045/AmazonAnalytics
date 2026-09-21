import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { bumpUserActivityBy } from '@/lib/activity/bump';
import { ResearchError } from './errors';
import type { ResearchLimits } from './limits';

export function minuteFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

export interface ReserveArgs {
  userId: string;
  channel: 'mcp';
  rows: number;
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
 */
export async function reserveResearchRequest(args: ReserveArgs): Promise<ReserveResult> {
  if (!Number.isSafeInteger(args.rows) || args.rows < 0) {
    throw new Error(`reserveResearchRequest: rows must be a non-negative safe integer, got ${args.rows}`);
  }
  const bucket = minuteFloor(args.now);
  const result = await db.execute(sql`
    INSERT INTO research_usage_buckets (user_id, channel, bucket_start, requests, "rows")
    VALUES (${args.userId}::uuid, ${args.channel}, ${bucket.toISOString()}::timestamptz, 1, ${args.rows})
    ON CONFLICT (user_id, channel, bucket_start) DO UPDATE
      SET requests = research_usage_buckets.requests + 1,
          "rows" = research_usage_buckets."rows" + EXCLUDED."rows"
    RETURNING requests, "rows"
  `);
  const row = (result.rows as Array<{ requests: number; rows: number }>)[0];
  if (!row) {
    throw new Error('reserveResearchRequest: upsert returned no row');
  }
  if (row.requests > args.limits.requestsPerMinute || row.rows > args.limits.rowsPerMinute) {
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
