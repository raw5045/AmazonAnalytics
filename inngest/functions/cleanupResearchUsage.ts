/**
 * Hourly cleanup of research_usage_buckets (amendment §6), on the Railway
 * worker. Per-minute usage buckets are only ever consulted for the current
 * minute, so this trims anything a day or older before the table can grow
 * unbounded under sustained MCP traffic.
 *
 * Safe to run before migration 0047 lands (it's owner-gated): the missing-
 * relation case is tolerated inside deleteStaleUsageBuckets, which returns
 * 0 instead of throwing, so this function never fails/retries/alerts on
 * that account — it just logs 0 deleted until the table exists.
 */
import { Pool } from 'pg';
import { inngest } from '../client';
import { deleteStaleUsageBuckets } from '@/lib/research/cleanup';

export const cleanupResearchUsageFn = inngest.createFunction(
  {
    id: 'cleanup-research-usage',
    name: 'Cleanup: research usage buckets older than a day',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '17 * * * *' }],
  },
  async () => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 30_000,
      statement_timeout: 60_000,
    });
    try {
      const deleted = await deleteStaleUsageBuckets(pool);
      console.log(`[cleanup-research-usage] deleted ${deleted} buckets`);
      return { deleted };
    } finally {
      await pool.end();
    }
  },
);
