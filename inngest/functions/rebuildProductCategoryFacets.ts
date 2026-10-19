// inngest/functions/rebuildProductCategoryFacets.ts
import { Pool } from 'pg';
import { inngest } from '../client';
import { env } from '@/lib/env';
import { errFields } from '@/lib/ask/logSafe';
import { buildProductCategoryFacets } from '@/lib/products/buildCategoryFacets';

/**
 * Daily rebuild of product_category_facets (spec 2026-10-19 §5, §14): the Products page's department and
 * leaf-category lists and the Products tools' category-path check read this table; the weekly import rebuilds
 * it (category_facets_build), and the Keepa service adds paths all week, so without this cron a path first seen
 * after the import is missing (and rejected by the tools as CATEGORY_NOT_AVAILABLE) until the next import.
 * Runs on the Railway worker at 14:00 ET daily (DST-safe; clear of the 03:30–05:59 ET nightly sync and the
 * 6-hourly chart sweep; the 15-minute pings share the minute and touch nothing it locks). An owner-started
 * import may be running: harmless — the build reads one snapshot of asin_products (the Keepa enqueue is one
 * transaction), the import's own category_facets_build runs after keepa_enqueue, and a run that meets it queues
 * on the table lock (≤120 s) or fails with 55P03. Seconds when warm (600 s cap); on import day the VACUUM may
 * have to wait for autovacuum, which only costs the readers a few heap fetches. Fail-soft: a failure is logged
 * with coded fields and the previous rows stay (the builder replaces them in one transaction and refuses an
 * empty build); the handler never throws, so tomorrow's run is the retry for a failed build, and retries: 1
 * only re-runs a transport failure.
 */
export const rebuildProductCategoryFacetsFn = inngest.createFunction(
  {
    id: 'rebuild-product-category-facets',
    name: 'Daily: rebuild product_category_facets',
    retries: 1, // the handler never throws, so this only re-runs a transport failure (a worker restart at 14:00); the build is idempotent and serialized by its lock
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=America/New_York 0 14 * * *' }],
  },
  async () => {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      statement_timeout: 600_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 20_000,
    });
    // Dropped-socket guards, as in the import phase: an unhandled 'error' event crashes the worker; a failed query still rejects.
    pool.on('error', () => undefined);
    // total: connect, build and the post-COMMIT VACUUM
    const started = Date.now();
    let stage: 'connect' | 'build' = 'connect';
    try {
      const client = await pool.connect();
      stage = 'build';
      try {
        client.on('error', () => undefined);
        const r = await buildProductCategoryFacets(client);
        const ms = Date.now() - started;
        console.log(`[category-facets] daily paths=${r.paths} departments=${r.departments} products=${r.products} in ${ms}ms`);
        return { ok: true as const, ...r, ms };
      } finally {
        client.release();
      }
    } catch (e) {
      const { error, code } = errFields(e);
      console.error('[category-facets] daily rebuild failed (previous rows stay)', JSON.stringify({ stage, error, code }));
      return { ok: false as const, stage, code };
    } finally {
      await pool.end();
    }
  },
);
