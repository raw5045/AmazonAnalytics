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
import { keepaServiceStatus } from '@/db/schema';

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
  /** In-scope tier 1, not delisted, last fetched more than 8 days ago. The freshness target is 0. */
  tier1Stale: number;
  /** In-scope tier 1 whose latest fetch failed (consecutive_errors > 0), i.e. in error backoff. */
  tier1Erroring: number;
  tier2InScope: number;
  tier2NeverFetched: number;
  tier2Due: number;
  fetchedLast24h: number;
  fetchedLast7d: number;
  /** Oldest fetch among in-scope tier-1 rows that are not delisted (delisted rows recheck monthly). */
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
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** `kcsWeek` is the explorer's current week, which the page has already read from keyword_current_summary_meta. */
export async function loadKeepaServiceOverview(kcsWeek: string | null): Promise<KeepaServiceOverview> {
  const [statusRows, countsRes] = await Promise.all([
    db.select().from(keepaServiceStatus).limit(1),
    db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE in_scope AND tier = 1)::int AS tier1_in_scope,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND last_fetched_at IS NULL)::int AS tier1_never_fetched,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND last_fetched_at IS NOT NULL AND next_due_at <= now())::int AS tier1_due,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND enrichment_status IS DISTINCT FROM 'delisted' AND last_fetched_at < now() - interval '8 days')::int AS tier1_stale,
      COUNT(*) FILTER (WHERE in_scope AND tier = 1 AND consecutive_errors > 0)::int AS tier1_erroring,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2)::int AS tier2_in_scope,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2 AND last_fetched_at IS NULL)::int AS tier2_never_fetched,
      COUNT(*) FILTER (WHERE in_scope AND tier = 2 AND last_fetched_at IS NOT NULL AND next_due_at <= now())::int AS tier2_due,
      COUNT(*) FILTER (WHERE last_fetched_at > now() - interval '24 hours')::int AS fetched_last_24h,
      COUNT(*) FILTER (WHERE last_fetched_at > now() - interval '7 days')::int AS fetched_last_7d,
      MIN(last_fetched_at) FILTER (WHERE in_scope AND tier = 1 AND enrichment_status IS DISTINCT FROM 'delisted') AS oldest_tier1_fetched_at,
      COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::int AS claimed,
      MAX(scope_week)::text AS scope_week
    FROM asin_products`),
  ]);
  const s = statusRows[0];
  const status: KeepaServiceStatusView | null = s
    ? {
        bootId: s.bootId,
        bootedAt: s.bootedAt,
        heartbeatAt: s.heartbeatAt,
        lastBatchAt: s.lastBatchAt,
        lastBatchLane: s.lastBatchLane,
        tokensLeft: s.tokensLeft,
        refillRate: s.refillRate,
        tailEnabled: s.tailEnabled,
        lastErrorCode: s.lastErrorCode,
        lastErrorAt: s.lastErrorAt,
        laneNewDrainedAt: s.laneNewDrainedAt,
        syncFiredAt: s.syncFiredAt,
      }
    : null;

  const c = countsRes.rows[0] ?? {};
  // Every alias must be present: a renamed or dropped column fails loudly, with a code the card and
  // the log can show, instead of reading as 0.
  const col = (k: string): unknown => {
    if (!(k in c)) throw Object.assign(new Error(`keepa overview: aggregate column ${k} missing`), { code: `overview_missing:${k}` });
    return c[k];
  };
  const n = (k: string) => Number(col(k));
  return {
    status,
    counts: {
      tier1InScope: n('tier1_in_scope'),
      tier1NeverFetched: n('tier1_never_fetched'),
      tier1Due: n('tier1_due'),
      tier1Stale: n('tier1_stale'),
      tier1Erroring: n('tier1_erroring'),
      tier2InScope: n('tier2_in_scope'),
      tier2NeverFetched: n('tier2_never_fetched'),
      tier2Due: n('tier2_due'),
      fetchedLast24h: n('fetched_last_24h'),
      fetchedLast7d: n('fetched_last_7d'),
      oldestTier1FetchedAt: ts(col('oldest_tier1_fetched_at')),
      claimed: n('claimed'),
      scopeWeek: (col('scope_week') as string | null) ?? null,
      kcsWeek,
    },
  };
}
