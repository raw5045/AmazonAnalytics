// tests/integration/baCrosswalk.test.ts
/**
 * computeCrosswalk (lib/baCategory/buildCrosswalk.ts) against production, READ-ONLY (spec 2026-10-14 §12),
 * in two cases. First the votes statement and the paths statement are planned (EXPLAIN inside a BEGIN READ
 * ONLY … ROLLBACK wrapper). Then they run for the Explorer week through computeCrosswalk, on the client
 * directly (it opens its own REPEATABLE READ READ ONLY transaction and commits it; it never writes), and
 * the assignment is checked for shape, coverage and two known paths inside the wrapper (writeCrosswalk is
 * never called; the real table is never written).
 *
 * Run on the owner's go only, never in CI, and AFTER productsQueries.test.ts: this file scans the catalog
 * (the votes join, the paths read, the coverage count), which would warm the pages that file times cold:
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/baCrosswalk.test.ts --disableConsoleIntercept
 * Preconditions: migration 0053 applied (the table may be empty: only kwm and the catalog are read);
 * the Explorer week imported; prefer a quiet hour (the votes read aggregates the week's slot-1 rows of
 * the kwm partition: minutes cold); compare it with the first build's time (Task 9 step 2). The plans
 * come first: the EXPLAIN case runs before the compute, so the votes plan is printed before a read that
 * cannot be cancelled starts.
 *
 * Cancellation: computeCrosswalk's own transaction sets statement_timeout (1800 s) and work_mem but no
 * client_connection_check_interval, so a Ctrl-C or a kill during the votes read does not stop that
 * statement: it keeps running on the server up to its 1800 s limit. The checks and EXPLAINs run in the
 * wrapper, which carries the 10 s connection check and a 300 s timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { CATALOG_PATHS_SQL, computeCrosswalk, votesSql } from '@/lib/baCategory/buildCrosswalk';
import { MIN_VOTES, prefixesOf } from '@/lib/baCategory/assignCodes';

const RUN = !!process.env.RUN_INTEGRATION;
const TEST_TIMEOUT_MS = 10 * 60_000;
const COMPUTE_TEST_TIMEOUT_MS = 31 * 60_000; // above computeCrosswalk's own 1800 s statement_timeout
const HOOK_TIMEOUT_MS = 2 * 60_000;
const TOILET_PAPER = 'Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper';

describe.skipIf(!RUN)('BA crosswalk compute (integration, read-only)', () => {
  let pool: Pool;
  let client: PoolClient;
  let week: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 60_000 });
    pool.on('error', () => undefined);
    client = await pool.connect();
    client.on('error', () => undefined);
    const table = await client.query<{ ok: boolean }>("SELECT to_regclass('ba_category_crosswalk') IS NOT NULL AS ok");
    if (!table.rows[0]?.ok) throw new Error('migration 0053 is not applied (ba_category_crosswalk is missing)');
    const kcs = await client.query<{ week: string }>('SELECT current_week_end_date::text AS week FROM keyword_current_summary_meta WHERE singleton');
    if (!kcs.rows[0]) throw new Error('keyword_current_summary_meta has no row: the explorer week is unknown');
    week = kcs.rows[0].week;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await client?.query('ROLLBACK').catch(() => undefined);
    } finally {
      client?.release();
      await pool?.end();
    }
  }, HOOK_TIMEOUT_MS);

  /** BEGIN READ ONLY … ROLLBACK around `fn`: a write would error, and nothing persists either way. */
  async function inReadOnlyTransaction(fn: () => Promise<void>): Promise<void> {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300s'");
      await client.query("SET LOCAL client_connection_check_interval = '10s'");
      // The compute's own work_mem, so the EXPLAINs show the compute's own plans.
      await client.query("SET LOCAL work_mem = '256MB'");
      await fn();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  // First on purpose: planning is cheap, and the plans print before the compute starts a read that cannot be cancelled.
  it(
    'the two statements plan on the partition and the catalog (plans printed, not executed)',
    async () => {
      await inReadOnlyTransaction(async () => {
        const votes = votesSql(week);
        const votesPlan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (FORMAT TEXT) ${votes.text}`, votes.values);
        const votesLines = votesPlan.rows.map((r) => r['QUERY PLAN']);
        console.log(`[baCrosswalk] votes plan:\n${votesLines.join('\n')}`);
        expect(votesLines.join('\n')).toContain(`keyword_weekly_metrics_${week.slice(0, 4)}`);
        expect(votesLines.join('\n')).toContain('asin_products');
        const pathsPlan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (FORMAT TEXT) ${CATALOG_PATHS_SQL}`);
        const pathsLines = pathsPlan.rows.map((r) => r['QUERY PLAN']);
        console.log(`[baCrosswalk] paths plan:\n${pathsLines.join('\n')}`);
        expect(pathsLines.join('\n')).toContain('asin_products');
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'computes the Explorer week: each catalog path at most once, sources are the path or an ancestor, shares in range, coverage, the two known paths',
    async () => {
      // computeCrosswalk opens its own REPEATABLE READ READ ONLY transaction with its SET LOCAL limits, so it runs outside the wrapper.
      const started = performance.now();
      const { rows, stats } = await computeCrosswalk(client, week);
      const seconds = (performance.now() - started) / 1000;
      console.log(`[baCrosswalk] week ${week}: ${JSON.stringify(stats)} in ${seconds.toFixed(1)}s (compare with the first build's time)`);
      await inReadOnlyTransaction(async () => {
        expect(stats.paths, 'paths').toBe(rows.length);
        expect(stats.direct + stats.backedOff, 'direct + backedOff').toBe(stats.paths);
        expect(new Set(rows.map((r) => r.categoryPath)).size, 'distinct paths').toBe(rows.length);
        for (const r of rows) {
          expect(prefixesOf(r.categoryPath), `source of ${r.categoryPath}`).toContain(r.sourcePath);
          expect(r.sharePct, `share of ${r.categoryPath}`).toBeGreaterThanOrEqual(0);
          expect(r.sharePct, `share of ${r.categoryPath}`).toBeLessThanOrEqual(100);
          expect(r.votes, `votes of ${r.categoryPath}`).toBeGreaterThanOrEqual(1);
          // A path that decided itself below the department level had the threshold.
          if (r.sourcePath === r.categoryPath && prefixesOf(r.categoryPath).length > 1) expect(r.votes, `votes of ${r.categoryPath}`).toBeGreaterThanOrEqual(MIN_VOTES);
        }
        // Coverage weighted by the products the page can show that have a Keepa path (the 0.8 % without one never get a code and are
        // not counted): spec §2 puts 86 % in paths with 20+ votes of their own; "without a code" is a path whose department has no
        // vote, expected near 0 (spec §12 bounds it under 1 %).
        const weights = await client.query<{ category_path: string; n: number }>(
          "SELECT category_path, count(*)::int AS n FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL GROUP BY 1",
        );
        const byPath = new Map(rows.map((r) => [r.categoryPath, r] as const));
        let total = 0;
        let direct = 0;
        let uncoded = 0;
        for (const w of weights.rows) {
          total += w.n;
          const r = byPath.get(w.category_path);
          if (!r) uncoded += w.n;
          else if (r.sourcePath === r.categoryPath) direct += w.n;
        }
        console.log(`[baCrosswalk] sellable products with a path: ${total}; decided by their own path ${((100 * direct) / total).toFixed(1)}%; without a code ${((100 * uncoded) / total).toFixed(2)}%`);
        // The mixed paths (spec §5.2: the winner holds under 70 % of the votes): the per-product override of spec §14 stands or falls with
        // how many sellable products sit in them.
        const mixed = rows.filter((r) => r.sharePct < 70);
        const mixedPaths = new Set(mixed.map((r) => r.categoryPath));
        let mixedProducts = 0;
        for (const w of weights.rows) if (mixedPaths.has(w.category_path)) mixedProducts += w.n;
        console.log(`[baCrosswalk] mixed paths (share < 70 %): ${mixed.length} paths, ${mixedProducts} sellable products (${((100 * mixedProducts) / total).toFixed(1)} %)`);
        expect(direct / total, 'share of sellable products decided by their own path').toBeGreaterThanOrEqual(0.8);
        expect(uncoded / total, 'share of sellable products without a code').toBeLessThan(0.01);
        // Two known paths (spec §2).
        const toilet = byPath.get(TOILET_PAPER);
        console.log(`[baCrosswalk] toilet paper: ${JSON.stringify(toilet)}`);
        expect(toilet?.code, 'the toilet paper path').toBe('Health & Personal Care');
        const underPetSupplies = (path: string): boolean => path === 'Pet Supplies' || path.startsWith('Pet Supplies › ');
        const pet = rows.filter((r) => underPetSupplies(r.categoryPath));
        const petPathsMapped = pet.filter((r) => r.code === 'Pet Products').length;
        console.log(`[baCrosswalk] Pet Supplies: ${petPathsMapped} of ${pet.length} paths map to Pet Products`);
        // Weighted by the sellable products of each path (the weights read above), as spec §2 states it: Pet Products for 97 % of the department's products.
        let petTotal = 0;
        let petMapped = 0;
        for (const w of weights.rows) {
          if (!underPetSupplies(w.category_path)) continue;
          petTotal += w.n;
          if (byPath.get(w.category_path)?.code === 'Pet Products') petMapped += w.n;
        }
        console.log(`[baCrosswalk] Pet Supplies: ${petMapped} of ${petTotal} sellable products sit in a path that maps to Pet Products`);
        expect(petTotal, 'sellable products under Pet Supplies').toBeGreaterThan(0);
        expect(petMapped / petTotal, 'share of Pet Supplies products in a path mapped to Pet Products').toBeGreaterThanOrEqual(0.8);
      });
    },
    COMPUTE_TEST_TIMEOUT_MS,
  );
});
