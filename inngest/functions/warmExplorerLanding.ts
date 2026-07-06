/**
 * Keep-warm cron for the explorer landing (runs on the Railway worker).
 *
 * Every 4 minutes during waking hours (7am–11pm ET) it runs the real
 * default-landing query. Two effects:
 *   1. Neon compute never auto-suspends during the day (pings land inside
 *      the 5-minute suspend window), so its local file cache — which is
 *      lost on suspend — stays populated.
 *   2. The top-of-rank pages the landing reads stay resident.
 * Net: a real visitor's "cold" load collapses to the warm path (~0.3–0.7s
 * browser-perceived) instead of compute-resume + cold IO (~2–5s), and the
 * post-churn 30s+ class is already handled at the source by the write jobs
 * vacuuming + warming (see worker/kcsKeepaSyncJobs.ts, refreshSummary.ts).
 *
 * Cost: keeps Neon compute up ~16h/day — the accepted "always-on floor"
 * trade-off from the pre-launch ops checklist.
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
    triggers: [{ cron: 'TZ=America/New_York */4 7-22 * * *' }],
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
