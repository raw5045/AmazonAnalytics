// scripts/buildKeywordCounts.ts
/**
 * Write asin_products.keyword_count by hand (spec 2026-10-23 §5): the one-off first build after migration 0056 (every
 * count starts at 0), or a re-run after the import's own keyword_counts_build phase logged a failure. Sets each
 * product's count from keyword_top_asins (the current week only) and zeroes the products that dropped out, in one
 * transaction (lib/products/buildKeywordCounts.ts), then refreshes the catalog's statistics (a best-effort ANALYZE).
 * Only changed rows are written, so a re-run is idempotent and cheap.
 *
 * Run: node --env-file=.env.local --import tsx scripts/buildKeywordCounts.ts
 * KEYWORD_COUNTS_DRY_RUN=1 runs one read-only statement instead: the count of distinct ASINs in keyword_top_asins (about
 * the rows the first build writes: those of them the catalog holds). It never touches asin_products, so it cannot see a
 * missing migration 0056 — the build itself fails loudly on that (42703).
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — the write updates the live catalog's rows. While it runs it
 * holds the Keepa service's lock (ENQUEUE_LOCK_KEY), so the service's batch writes wait for the COMMIT, and a run during
 * an import's keepa_enqueue waits for that phase first.
 * Time: the first build touches every catalog row with a count (about 2.5M: every product in the pair table), each
 * update non-HOT because the column is indexed, so it may take well over a minute; hence the 30-minute statement limit
 * here (the weekly phase keeps the builder's 600 s default: it writes only the changed counts). Later runs are quick.
 */
import { Pool } from 'pg';
import { buildKeywordCounts } from '@/lib/products/buildKeywordCounts';

if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
// Only the exact value 1 is a dry run; anything else ("0", "true", empty) is refused, not ignored.
if (process.env.KEYWORD_COUNTS_DRY_RUN !== undefined && process.env.KEYWORD_COUNTS_DRY_RUN !== '1') {
  console.error('Refusing to run: KEYWORD_COUNTS_DRY_RUN must be 1 (set KEYWORD_COUNTS_DRY_RUN=1 or unset it).');
  process.exit(1);
}
const dryRun = process.env.KEYWORD_COUNTS_DRY_RUN === '1';

/** The build's statement limit (30 minutes, see the header); the Pool's own limit below is the same, never shorter. */
const STATEMENT_LIMIT_SECONDS = 1800;

/** The dry run's one statement (read-only): the distinct ASINs of the pair table. */
const DISTINCT_ASINS_SQL = 'SELECT count(*)::int AS n FROM (SELECT asin FROM keyword_top_asins GROUP BY asin) c';

/** What to do next, by error code (a SQLSTATE), when a run fails. */
const HINTS: Readonly<Record<string, string>> = {
  '42703': 'asin_products.keyword_count does not exist: apply migration 0056 first.',
  '42P01': 'keyword_top_asins or asin_products does not exist: wrong DATABASE_URL?',
  '57014': "a statement hit its 30-minute limit or was cancelled (a cold catalog? an import's keepa_enqueue holding the Keepa lock?): re-run.",
};

let stage: 'connect' | 'run' = 'connect';
(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    // At least the build's limit. It does not bind through Neon's pooler: the library's transaction sets its own limit with SET LOCAL.
    statement_timeout: STATEMENT_LIMIT_SECONDS * 1000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guard, as in scripts/buildProductCategoryFacets.ts: an unhandled 'error' would crash the script.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  stage = 'run';
  try {
    client.on('error', () => undefined);
    if (dryRun) {
      console.log('counting the distinct ASINs of keyword_top_asins (read-only)');
      const t0 = Date.now();
      const { rows } = await client.query<{ n: number }>(DISTINCT_ASINS_SQL);
      console.log(`counted in ${((Date.now() - t0) / 1000).toFixed(1)}s: distinctAsins=${rows[0]?.n ?? 0}`);
    } else {
      console.log(`writing asin_products.keyword_count from keyword_top_asins (statement limit ${STATEMENT_LIMIT_SECONDS} s)`);
      const r = await buildKeywordCounts(client, { statementTimeoutSeconds: STATEMENT_LIMIT_SECONDS });
      console.log(`built: updated=${r.updated} zeroed=${r.zeroed} seconds=${r.seconds.toFixed(1)} analyze=${r.analyzed ? 'ok' : 'failed'}`);
      if (!r.analyzed) console.log('The counts are committed; only the statistics refresh failed: autoanalyze catches up (or run ANALYZE asin_products).');
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  const code = (e as { code?: string })?.code ?? '';
  console.error(`failed (${stage}):`, e instanceof Error ? e.name : 'unknown', code);
  if (HINTS[code]) console.error(HINTS[code]);
  if (!dryRun && stage === 'run') console.error('Re-running is safe (the transaction rolled back); do not push until a run prints "built".');
  process.exit(1);
});
