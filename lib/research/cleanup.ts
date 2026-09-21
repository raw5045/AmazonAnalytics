/**
 * Hourly cleanup of research_usage_buckets (amendment §6): per-minute usage
 * buckets are only ever consulted for the current minute (see usage.ts's
 * reserveResearchRequest), so anything older than a day is pure noise —
 * deleted so the table doesn't grow unbounded under sustained MCP traffic.
 */
export const STALE_BUCKETS_SQL =
  "DELETE FROM research_usage_buckets WHERE bucket_start < now() - interval '1 day'";

/**
 * Deletes stale buckets and returns how many rows were removed.
 *
 * Tolerant of migration 0047 not having landed yet (it's owner-gated, so
 * this cron can start running before the table exists): a missing-relation
 * error (SQLSTATE 42P01) is caught here, logged once as a warning, and
 * treated as "nothing to delete" rather than failing the run — an Inngest
 * failure here would retry and alert on every tick until the owner applies
 * the migration. Any other error (a real connection/query failure) is
 * rethrown so Inngest's retry/alerting still covers it.
 */
export async function deleteStaleUsageBuckets(q: {
  query: (sql: string) => Promise<{ rowCount: number | null }>;
}): Promise<number> {
  try {
    const r = await q.query(STALE_BUCKETS_SQL);
    return r.rowCount ?? 0;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') {
      console.warn('[cleanup-research-usage] table not present yet');
      return 0;
    }
    throw err;
  }
}
