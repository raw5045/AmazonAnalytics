/**
 * Keep-warm cron for the keyword_chart_series storage layers (runs on the
 * Railway worker), every 6 hours ET — the 6am tick pre-warms the morning.
 *
 * The detail page reads one ~4-page series row per keyword. When the table's
 * layers age out of Neon's pageserver cache (it's rewritten weekly, then
 * sits mostly unread), each cold page is served by pulling a whole layer
 * file from S3 — measured at 1.5-15s per single-row lookup on 2026-07-07
 * (the "9.5s detail page" incident). One sequential sweep re-pins every
 * layer; random keyword lookups then stay in the tens of milliseconds.
 *
 * Also a canary: each tick logs its duration. A sweep that suddenly takes
 * much longer (or a table that's grown far past ~9GB) is a churn/bloat
 * regression to investigate before a visitor feels it.
 *
 * Cost: a full sequential read of the ~8.8GB table, 4×/day, from the worker
 * — no user-facing query competes with it at those hours.
 */
import { Pool } from 'pg';
import { inngest } from '../client';
import { warmChartSeriesLayers } from '@/lib/explorer/warmSeries';

export const warmChartSeriesFn = inngest.createFunction(
  {
    id: 'warm-chart-series',
    name: 'Keep-warm: chart-series storage layers',
    retries: 0, // it's a sweep — the next tick is the retry
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=America/New_York 0 */6 * * *' }],
  },
  async () => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 30_000,
      // First sweep after a rewrite can take minutes (layer downloads).
      statement_timeout: 900_000,
    });
    try {
      const result = await warmChartSeriesLayers(pool);
      console.log(
        `[warm-chart-series] ${result.ok ? 'ok' : 'FAILED'} rows=${result.rows} data=${result.mb}MB in ${result.ms}ms`,
      );
      return result;
    } finally {
      await pool.end();
    }
  },
);
