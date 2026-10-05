// lib/admin/keepaServiceOverview.ts
/**
 * Data for the admin status card (spec 2026-10-05 §8): the service's status row plus one
 * aggregate pass over asin_products. Admin-only; a few seconds on 2.3M rows is acceptable.
 *
 * Lives outside lib/keepa/ on purpose: it loads the app's database client (db/client, and through
 * it the full env schema), and lib/keepa/** is a Railway watch path for the Keepa service.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const DAILY_CAPACITY_ASINS = 180_000;
export const WEEKLY_CAPACITY_ASINS = 7 * DAILY_CAPACITY_ASINS;

export interface KeepaServiceStatusView {
  bootId: string | null;
  bootedAt: Date | null;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  lastBatchLane: string | null;
  tokensLeft: number | null;
  refillRate: number | null;
  tailEnabled: boolean;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  laneNewDrainedAt: Date | null;
  syncFiredAt: Date | null;
}

export interface KeepaQueueCounts {
  tier1InScope: number;
  tier1NeverFetched: number;
  tier1Due: number;
  tier2InScope: number;
  tier2NeverFetched: number;
  tier2Due: number;
  fetchedLast24h: number;
  fetchedLast7d: number;
  oldestTier1FetchedAt: Date | null;
  claimed: number;
  scopeWeek: string | null;
  kcsWeek: string | null;
}

export interface KeepaServiceOverview {
  status: KeepaServiceStatusView | null;
  counts: KeepaQueueCounts;
}

function ts(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return null;
}

export async function loadKeepaServiceOverview(): Promise<KeepaServiceOverview> {
  const statusRes = await db.execute<Record<string, unknown>>(sql`
    SELECT boot_id, booted_at, heartbeat_at, last_batch_at, last_batch_lane, tokens_left, refill_rate, tail_enabled,
           last_error_code, last_error_at, lane_new_drained_at, sync_fired_at
    FROM keepa_service_status WHERE singleton`);
  const s = statusRes.rows[0];
  const status: KeepaServiceStatusView | null = s
    ? {
        bootId: (s.boot_id as string | null) ?? null,
        bootedAt: ts(s.booted_at),
        heartbeatAt: ts(s.heartbeat_at),
        lastBatchAt: ts(s.last_batch_at),
        lastBatchLane: (s.last_batch_lane as string | null) ?? null,
        tokensLeft: (s.tokens_left as number | null) ?? null,
        refillRate: (s.refill_rate as number | null) ?? null,
        tailEnabled: Boolean(s.tail_enabled),
        lastErrorCode: (s.last_error_code as string | null) ?? null,
        lastErrorAt: ts(s.last_error_at),
        laneNewDrainedAt: ts(s.lane_new_drained_at),
        syncFiredAt: ts(s.sync_fired_at),
      }
    : null;

  const countsRes = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE in_scope AND tier = 1)::int AS tier1_in_scope,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND last_fetched_at IS NULL)::int AS tier1_never_fetched,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND last_fetched_at IS NOT NULL AND next_due_at <= now())::int AS tier1_due,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2)::int AS tier2_in_scope,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2 AND last_fetched_at IS NULL)::int AS tier2_never_fetched,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2 AND last_fetched_at IS NOT NULL AND next_due_at <= now())::int AS tier2_due,
      COUNT(*) FILTER (WHERE last_fetched_at > now() - interval '24 hours')::int AS fetched_last_24h,
      COUNT(*) FILTER (WHERE last_fetched_at > now() - interval '7 days')::int AS fetched_last_7d,
      MIN(last_fetched_at) FILTER (WHERE in_scope AND tier = 1) AS oldest_tier1_fetched_at,
      COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::int AS claimed,
      MAX(scope_week)::text AS scope_week
    FROM asin_products`);
  const c = countsRes.rows[0] ?? {};
  const n = (k: string) => Number(c[k] ?? 0);
  const kcsRes = await db.execute(sql`SELECT current_week_end_date::text AS cw FROM keyword_current_summary_meta WHERE singleton = true`);
  return {
    status,
    counts: {
      tier1InScope: n('tier1_in_scope'),
      tier1NeverFetched: n('tier1_never_fetched'),
      tier1Due: n('tier1_due'),
      tier2InScope: n('tier2_in_scope'),
      tier2NeverFetched: n('tier2_never_fetched'),
      tier2Due: n('tier2_due'),
      fetchedLast24h: n('fetched_last_24h'),
      fetchedLast7d: n('fetched_last_7d'),
      oldestTier1FetchedAt: ts(c.oldest_tier1_fetched_at),
      claimed: n('claimed'),
      scopeWeek: (c.scope_week as string | null) ?? null,
      kcsWeek: (kcsRes.rows[0]?.cw as string | null | undefined) ?? null,
    },
  };
}
