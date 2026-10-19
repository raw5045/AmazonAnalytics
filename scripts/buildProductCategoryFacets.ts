// scripts/buildProductCategoryFacets.ts
/**
 * Rebuild product_category_facets by hand (spec 2026-10-19 §5): the one-off first build after migration 0055, or
 * a re-run after the import's own category_facets_build phase logged a failure. Replaces the table's rows in one
 * transaction from the live catalog (lib/products/buildCategoryFacets.ts); re-running is idempotent.
 *
 * Run: node --env-file=.env.local --import tsx scripts/buildProductCategoryFacets.ts
 * PRODUCT_FACETS_DRY_RUN=1 counts the rows a successful build would write (read-only; it never touches the table, so it
 * cannot see a missing migration 0055 or a path with two departments — the build itself fails loudly on both).
 * A build that would write zero rows is refused by the library (facets_empty) and leaves the previous rows in place.
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — the write replaces the live table's rows (readers keep
 * the previous rows until the commit). The GROUP BY scans the catalog (1.5 s warm on 2026-10-19, longer cold); the
 * printed time also covers the VACUUM after the COMMIT: a few seconds in all.
 * Expect about 23.4k paths, 36 departments and 1.18M products (spec 2026-10-19 §2: 23,429 / 36 / 1,176,481 on 2026-10-19).
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

/** What to do next, by error code (a SQLSTATE or a FacetsBuildError code), when a run fails. */
const HINTS: Readonly<Record<string, string>> = {
  '42P01': 'product_category_facets does not exist: apply migration 0055 first.',
  '23505': 'a catalog path carries two departments: the build refuses to store either (lib/products/buildCategoryFacets.ts).',
  '55P03': "another facets build holds the table (the import's category_facets_build?): re-run when it ends.",
  '57014': 'a statement hit its 600 s limit or was cancelled (cold catalog?): re-run.',
  'facets_empty': 'the catalog matched no path, so nothing was written and last build\'s rows stay (wrong DATABASE_URL? empty catalog?): fix the cause and re-run before pushing.',
};

let stage: 'connect' | 'run' = 'connect';
(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    // As in the import phase. It does not bind through Neon's pooler: the library's transactions set their own limits with SET LOCAL.
    statement_timeout: 600_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guard, as in scripts/buildBaCrosswalk.ts: an unhandled 'error' would crash the script.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  stage = 'run';
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
  const code = (e as { code?: string })?.code ?? '';
  console.error(`failed (${stage}):`, e instanceof Error ? e.name : 'unknown', code);
  if (HINTS[code]) console.error(HINTS[code]);
  if (!dryRun && stage === 'run') console.error('Re-running is safe; do not push until a run prints "built".');
  process.exit(1);
});
