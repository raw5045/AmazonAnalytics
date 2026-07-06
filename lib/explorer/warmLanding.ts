/**
 * Warm the explorer's default landing path: run the exact meta lookup +
 * default rows query a real signed-in visitor triggers on /explorer.
 *
 * Why: the landing's top-of-rank pages go cold in two ways — (a) Neon's
 * local file cache dies whenever compute suspends, and (b) mass-UPDATE jobs
 * (the weekly kcs Keepa sync, one-off backfills) leave freshly-written pages
 * whose first reader pays hint-bit writes on top of cold IO. Running the
 * real query once from the job that caused the churn (or from the keep-warm
 * cron) makes the write job pay that cost instead of the first human.
 *
 * Fail-soft by design: warming is an optimization — it must never fail the
 * calling job. Callers pass any pg-compatible client (worker PoolClient or a
 * one-off Pool); this module is dependency-free beyond the query builder.
 */
import { buildExplorerQuery } from './buildQuery';
import { parseExplorerFilters } from './parseFilters';

export interface Queryable {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface WarmResult {
  ok: boolean;
  ms: number;
  rows: number;
  week?: string;
}

export async function warmExplorerLanding(client: Queryable): Promise<WarmResult> {
  const t0 = Date.now();
  try {
    const { rows: meta } = await client.query(
      `SELECT current_week_end_date::text AS cw
       FROM keyword_current_summary_meta WHERE singleton = true`,
    );
    if (meta.length === 0) return { ok: false, ms: Date.now() - t0, rows: 0 };
    const week = String(meta[0].cw).slice(0, 10);

    const q = buildExplorerQuery(parseExplorerFilters({}), week);
    const { rows } = await client.query(q.sql, q.args as unknown[]);
    return { ok: true, ms: Date.now() - t0, rows: rows.length, week };
  } catch (e) {
    console.warn('[warmExplorerLanding] failed (non-fatal):', (e as Error).message);
    return { ok: false, ms: Date.now() - t0, rows: 0 };
  }
}
