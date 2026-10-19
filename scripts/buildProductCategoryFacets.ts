// scripts/buildProductCategoryFacets.ts
/**
 * Rebuild product_category_facets by hand (spec 2026-10-19 §5): the one-off first build after migration 0055, or
 * a re-run after the import's own category_facets_build phase logged a failure. Replaces the table's rows in one
 * transaction from the live catalog (lib/products/buildCategoryFacets.ts); re-running is idempotent.
 *
 * Run: node --env-file=.env.local --import tsx scripts/buildProductCategoryFacets.ts
 * PRODUCT_FACETS_DRY_RUN=1 counts what a build would write (read-only) and prints the stats without writing.
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — the write replaces the live table's rows (readers keep
 * the previous rows until the commit). The GROUP BY scans the catalog: 1.5 s warm on 2026-10-19, longer cold.
 * Expect about 23.4k paths, 36 departments and 1.18M products; compare with the facets GROUP BY probe of 2026-10-19.
 */
import { Pool } from 'pg';
import { buildProductCategoryFacets, computeProductCategoryFacets } from '@/lib/products/buildCategoryFacets';

if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
// Only the exact value 1 is a dry run; anything else ("0", "true", empty) is refused, not ignored.
if (process.env.PRODUCT_FACETS_DRY_RUN !== undefined && process.env.PRODUCT_FACETS_DRY_RUN !== '1') {
  console.error('Refusing to run: PRODUCT_FACETS_DRY_RUN must be 1 (set PRODUCT_FACETS_DRY_RUN=1 or unset it).');
  process.exit(1);
}
const dryRun = process.env.PRODUCT_FACETS_DRY_RUN === '1';

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    // As in the import phase. It may not bind through Neon's pooler: the library's transactions set their own limits.
    statement_timeout: 600_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guard, as in scripts/buildBaCrosswalk.ts: an unhandled 'error' would crash the script.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    console.log(`${dryRun ? 'counting' : 'building'} the product category facets from the live catalog`);
    const t0 = Date.now();
    const stats = dryRun ? await computeProductCategoryFacets(client) : await buildProductCategoryFacets(client);
    console.log(
      `${dryRun ? 'counted' : 'built'} in ${((Date.now() - t0) / 1000).toFixed(1)}s: paths=${stats.paths} departments=${stats.departments} products=${stats.products}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
