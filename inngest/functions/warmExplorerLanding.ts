/**
 * Keep-warm cron for the explorer landing (runs on the Railway worker).
 *
 * Neon autosuspend is DISABLED on this project (owner setting), so this is
 * NOT about keeping compute alive. Its two remaining jobs, every 15 minutes
 * during waking hours (7am–11pm ET):
 *   1. Anti-eviction: the nightly jobs (refresh / enrichment / kcs sync)
 *      churn GBs through Neon's cache and evict the landing's ~630 pages;
 *      the ping keeps the exact visitor path resident into the morning.
 *   2. Canary: each tick logs its duration — if landing latency ever
 *      regresses (e.g. a new churn source, a lost index twin), the worker
 *      logs show it before a human hits it.
 * The 30s+ churn class is handled at the source by the write jobs vacuuming
 * + warming (worker/kcsKeepaSyncJobs.ts, refreshSummary.ts).
 *
 * Cost: negligible — a ~630-buffer cached query, ~64 runs/day.
 */
import { Pool } from 'pg';
import { inngest } from '../client';
import { warmExplorerLanding } from '@/lib/explorer/warmLanding';

export const warmExplorerLandingFn = inngest.createFunction(
  {
    id: 'warm-explorer-landing',
    name: 'Keep-warm: explorer landing query',
    retries: 0, // it's a ping — the next tick is the retry
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=America/New_York */15 7-22 * * *' }],
  },
  async () => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 30_000,
      statement_timeout: 60_000,
    });
    try {
      const result = await warmExplorerLanding(pool);
      console.log(
        `[warm-explorer-landing] ${result.ok ? 'ok' : 'FAILED'} week=${result.week ?? '?'} rows=${result.rows} in ${result.ms}ms`,
      );
      return result;
    } finally {
      await pool.end();
    }
  },
);
