/**
 * Warm the keyword_chart_series heap: one sequential sweep that touches every
 * table page, pulling the table's storage layers into Neon's caches.
 *
 * Why: the detail page reads ONE series row per keyword — a 4-page PK lookup.
 * But the table (~8.8GB) is fully rewritten by each weekly refresh, and once
 * its fresh layers age out of Neon's pageserver cache, each cold page is
 * served by downloading a whole layer file from S3 — measured at 1.5-15s for
 * a single-row lookup (2026-07-07 investigation, the "9.5s detail page").
 * Sweeping after the rewrite (and periodically from the cron) keeps every
 * layer resident, so random keyword lookups stay in the tens of milliseconds.
 *
 * The aggregate references the `series` column, which forces real heap-tuple
 * access for every row (a bare count(*) could satisfy from an index-only
 * scan and warm nothing). pg_column_size doesn't decompress — cheap CPU.
 *
 * Fail-soft by design: warming is an optimization — it must never fail the
 * calling job.
 */
import type { Queryable } from './warmLanding';

export interface WarmSeriesResult {
  ok: boolean;
  ms: number;
  rows: number;
  mb: number;
}

export async function warmChartSeriesLayers(client: Queryable): Promise<WarmSeriesResult> {
  const t0 = Date.now();
  try {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n,
              coalesce(sum(pg_column_size(series)), 0)::bigint AS bytes
       FROM keyword_chart_series`,
    );
    const n = Number(rows[0]?.n ?? 0);
    const mb = Math.round(Number(rows[0]?.bytes ?? 0) / 1_048_576);
    return { ok: true, ms: Date.now() - t0, rows: n, mb };
  } catch (e) {
    console.warn('[warmChartSeriesLayers] failed (non-fatal):', (e as Error).message);
    return { ok: false, ms: Date.now() - t0, rows: 0, mb: 0 };
  }
}
