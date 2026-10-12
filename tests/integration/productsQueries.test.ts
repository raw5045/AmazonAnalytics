// tests/integration/productsQueries.test.ts
/**
 * The Products page's queries against the real database (migration 0051 applied):
 *  - the default landing view and the owner's example search are planned (EXPLAIN) and must be served
 *    by the 0051 partial indexes; a short outline of each plan (node type, index, estimated rows) is
 *    printed;
 *  - the owner's search runs for real through searchProducts (rows + capped count), timed;
 *  - the category filter's three forms (spec 2026-10-12 §7), each planned and run through
 *    searchProducts, every row checked against its scope: a department-only search (the smallest
 *    department) and a leaf pick (its subtree) must be served by asin_products_category_path_idx; a
 *    real custom category's paths match exactly (the array form) — the smallest custom category for
 *    the index assertion, and the largest one planned and timed only (its plan may use the sort index
 *    instead; both are correct);
 *  - the option lists: the department and distinct-path counts among the rows the page can show; the
 *    estimated size of the largest per-department cache entry, which must stay well under Next's 2 MB
 *    limit; and the plan of the per-department list statement for the largest department, printed.
 *    The loaders themselves are not called (unstable_cache needs Next's request scope); the counts
 *    and the plan stand in for them;
 *  - the ASIN page's loaders (facts, snapshot history, keywords with weeks in top 3) answer for an ASIN
 *    taken from the search; an ASIN the reverse table has but the catalog lacks gets a stub
 *    (inCatalog false); an unknown ASIN has no facts.
 *
 * Read-only: every case runs inside BEGIN READ ONLY ... ROLLBACK on one dedicated connection (a stray
 * write would error), so nothing persists.
 *
 * Cancellation and timeouts (every transaction): SET LOCAL client_connection_check_interval = '10s'
 * makes the server stop a statement whose client process has died (Ctrl-C, kill) within ~10 s. A
 * vitest timeout does NOT trigger it: the test fails, but the process and its connection live on, so
 * the server keeps running the statement until it finishes or the statement timeout hits. The 300 s
 * statement timeout applies to each statement on its own; a case's 6-minute test timeout bounds the
 * sum of its statements as the test sees them, and stops nothing on the server.
 *
 * Preconditions (owner-run only, never in CI):
 *  - migration 0051 applied (the six partial indexes built and valid);
 *  - the reverse-table backfill done for the keyword and stub assertions: while keyword_top_asins_meta
 *    has no week they are skipped with a note ("reverse table not built yet");
 *  - a custom category with stored paths (any account's; only its paths are read) for the two
 *    custom-category cases: when there is none they are skipped ("no custom category to test with");
 *  - no import running. A cold Neon can take tens of seconds for the first reads.
 *
 * Run (owner's go, Git Bash):
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { EMPTY_CATEGORY_SCOPE, pageCategoryScope } from '@/lib/products/categoryPredicate';
import { PRODUCT_DEFAULTS, PRODUCT_PAGE_SIZE, type ProductFilters } from '@/lib/products/filters';
import { productSearchSql, searchProducts, type SqlRunner, type SqlStatement } from '@/lib/products/searchProducts';
import { loadProduct } from '@/lib/products/loadProduct';
import { loadProductHistory } from '@/lib/products/loadProductHistory';
import { loadProductKeywords, type ProductKeywordsResult } from '@/lib/products/loadProductKeywords';

const RUN = !!process.env.RUN_INTEGRATION;
/** Per statement (see the header). */
const STATEMENT_TIMEOUT = '300s';
/** How often the server checks that the client is still there while it runs a statement. */
const CONNECTION_CHECK_INTERVAL = '10s';
const TEST_TIMEOUT_MS = 6 * 60_000;
const HOOK_TIMEOUT_MS = 2 * 60_000;

/** The six partial indexes of migration 0051: (key, asin) over the rows the Products page can show. */
const PRODUCT_SEARCH_INDEXES = [
  'asin_products_listed_since_idx',
  'asin_products_monthly_sold_idx',
  'asin_products_review_count_idx',
  'asin_products_sales_rank_idx',
  'asin_products_price_idx',
  'asin_products_rank_ratio_idx',
] as const;
/** The category filter's index (migration 0050): category_path text_pattern_ops, partial on in_scope AND category_path IS NOT NULL. */
const CATEGORY_PATH_INDEX = 'asin_products_category_path_idx';

/** The owner's example search: listed within 180 days, 1,000+ sold a month, at most 300 reviews. */
const OWNER_SEARCH: ProductFilters = { ...PRODUCT_DEFAULTS, age: 180, soldMin: 1000, reviewsMax: 300 };

/** The parts of an EXPLAIN (FORMAT JSON) node these cases read. */
interface PlanNode {
  'Node Type': string;
  'Plan Rows': number;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  Plans?: PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
/** One line per plan node (node type, scan direction, index or relation, estimated rows), indented by depth. */
function outline(node: PlanNode, depth = 0): string[] {
  const on = node['Index Name'] ?? node['Relation Name'];
  const line = [node['Node Type'], node['Scan Direction'], on, `rows=${node['Plan Rows']}`].filter(Boolean).join(' ');
  return [`${'  '.repeat(depth)}${line}`, ...(node.Plans ?? []).flatMap((child) => outline(child, depth + 1))];
}

/** What every keyword row must carry, whatever the ASIN. */
function expectKeywordRows(result: ProductKeywordsResult): void {
  expect(result.total, 'total keywords').toBeGreaterThanOrEqual(0);
  expect(result.rows.length, 'rows shown against the total').toBeLessThanOrEqual(result.total);
  for (const row of result.rows) {
    expect(row.weeksInTop3, `weeks in top 3 of keyword ${row.searchTermId}`).toBeGreaterThanOrEqual(1);
    expect([1, 2, 3], `slot of keyword ${row.searchTermId}`).toContain(row.slot);
  }
}

describe.skipIf(!RUN)('Products queries (integration)', () => {
  let pool: Pool;
  let client: PoolClient;
  /** keyword_top_asins_meta.week_end_date: null until the first reverse-table build. */
  let metaWeek: string | null = null;
  let sample: { asin: string; from: string } | undefined;

  /** The page's runner shape, over the dedicated pg connection. */
  const run: SqlRunner = (text, values) => client.query(text, values).then((r) => r.rows);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 60_000 });
    pool.on('error', () => undefined);
    client = await pool.connect();
    client.on('error', () => undefined);
    const tables = await client.query<{ ok: boolean }>(
      "SELECT to_regclass('keyword_top_asins') IS NOT NULL AND to_regclass('keyword_top_asins_meta') IS NOT NULL AS ok",
    );
    if (!tables.rows[0]?.ok) throw new Error('migration 0051 is not applied (keyword_top_asins or keyword_top_asins_meta is missing)');
    const meta = await client.query<{ week: string | null }>('SELECT week_end_date::text AS week FROM keyword_top_asins_meta WHERE singleton');
    metaWeek = meta.rows[0]?.week ?? null;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      // Belt and braces: end any transaction a failed case left open.
      await client?.query('ROLLBACK').catch(() => undefined);
    } finally {
      client?.release();
      await pool?.end();
    }
  }, HOOK_TIMEOUT_MS);

  /** BEGIN READ ONLY ... ROLLBACK around `fn`: a write would error, and nothing persists either way. */
  async function inReadOnlyTransaction(fn: () => Promise<void>): Promise<void> {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query(`SET LOCAL client_connection_check_interval = '${CONNECTION_CHECK_INTERVAL}'`);
      await fn();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  /** EXPLAIN (FORMAT JSON) of a page statement with its real parameters (planned, not executed). */
  async function explain(q: SqlStatement): Promise<{ root: PlanNode; lines: string[]; seconds: number }> {
    const started = performance.now();
    const res = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${q.text}`, q.values);
    const seconds = (performance.now() - started) / 1000;
    const raw = res.rows[0]['QUERY PLAN'];
    const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    return { root: plan[0].Plan, lines: outline(plan[0].Plan), seconds };
  }

  /** An ASIN for the loader cases: the first row of the owner's search, else of the default view. */
  async function sampleAsin(): Promise<{ asin: string; from: string }> {
    if (sample) return sample;
    for (const [from, filters] of [['the owner search', OWNER_SEARCH], ['the default view', PRODUCT_DEFAULTS]] as const) {
      const first = (await searchProducts(run, filters, EMPTY_CATEGORY_SCOPE)).rows[0];
      if (first) return (sample = { asin: first.asin, from });
    }
    throw new Error('no product to sample: neither the owner search nor the default view returned a row');
  }

  it(
    'default landing view: the sold sort comes off asin_products_monthly_sold_idx',
    async () => {
      await inReadOnlyTransaction(async () => {
        const { root, lines, seconds } = await explain(productSearchSql({ ...PRODUCT_DEFAULTS }, EMPTY_CATEGORY_SCOPE).rows);
        console.log(`[productsQueries] default view planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);

        expect(lines.join('\n'), 'the plan of the default view').toContain('asin_products_monthly_sold_idx');
        // The top-N must come off the index. Any Sort left in the plan may only re-sort the one page the Limit hands it.
        const wideSorts = planNodes(root).filter((n) => /Sort$/.test(n['Node Type']) && n['Plan Rows'] > PRODUCT_PAGE_SIZE);
        expect(wideSorts.map((n) => `${n['Node Type']} rows=${n['Plan Rows']}`), `Sort nodes over more than a page (${PRODUCT_PAGE_SIZE} rows)`).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the owner's search (age 180, sold >= 1,000, reviews <= 300) uses a 0051 index and returns a page",
    async () => {
      await inReadOnlyTransaction(async () => {
        const { lines, seconds: planSeconds } = await explain(productSearchSql(OWNER_SEARCH, EMPTY_CATEGORY_SCOPE).rows);
        const plan = lines.join('\n');
        const used = PRODUCT_SEARCH_INDEXES.filter((name) => plan.includes(name));
        console.log(`[productsQueries] owner search planned in ${planSeconds.toFixed(2)}s (0051 indexes: ${used.join(', ') || 'none'}):\n${plan}`);
        expect(used.length, 'a 0051 partial index in the plan of the owner search').toBeGreaterThanOrEqual(1);

        const started = performance.now();
        const result = await searchProducts(run, OWNER_SEARCH, EMPTY_CATEGORY_SCOPE);
        const seconds = (performance.now() - started) / 1000;
        console.log(`[productsQueries] owner search ran in ${seconds.toFixed(2)}s: ${result.rows.length} rows on page ${result.page}, ${result.total}${result.totalIsCapped ? '+' : ''} matches`);
        if (result.rows.length === 0) console.log('[productsQueries] the owner search matched nothing; the loader cases fall back to the default view.');

        expect(result.rows.length, 'rows on the page').toBeLessThanOrEqual(PRODUCT_PAGE_SIZE);
        for (const row of result.rows) expect(row.asin, 'asin of a result row').toHaveLength(10);
        expect(result.total, 'total matches').toBeGreaterThanOrEqual(result.rows.length);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a department-only search (the smallest department) is served by the category path index',
    async () => {
      await inReadOnlyTransaction(async () => {
        const picked = await client.query<{ category_root: string }>(
          "SELECT category_root FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_root IS NOT NULL GROUP BY 1 ORDER BY count(*) ASC LIMIT 1",
        );
        const dept = picked.rows[0].category_root;
        const q = productSearchSql(PRODUCT_DEFAULTS, pageCategoryScope({ ...PRODUCT_DEFAULTS, dept }, []));
        const { lines, seconds } = await explain(q.rows);
        console.log(`[productsQueries] department "${dept}" planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        expect(lines.join('\n')).toContain(CATEGORY_PATH_INDEX);
        const result = await searchProducts(run, PRODUCT_DEFAULTS, pageCategoryScope({ ...PRODUCT_DEFAULTS, dept }, []));
        for (const row of result.rows) expect(row.categoryPath === dept || row.categoryPath?.startsWith(`${dept} › `), `${row.asin} in ${dept}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a leaf pick matches its subtree through the path index',
    async () => {
      await inReadOnlyTransaction(async () => {
        // A mid-size path (enough rows to fill a page, few enough that the bitmap plan is the cheap one), the deepest such
        // path first: deep paths are leaves, so the subtree half of the predicate stays small and the plan stays on the index.
        // Only rows with the monthly sold badge count: the default sort (sold) leaves out the rest, and the rows check below
        // needs rows the search can show.
        const picked = await client.query<{ category_path: string }>(
          "SELECT category_path FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND monthly_sold IS NOT NULL GROUP BY 1 HAVING count(*) BETWEEN 60 AND 400 ORDER BY length(category_path) DESC, category_path LIMIT 1",
        );
        const path = picked.rows[0].category_path;
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, leafPaths: [path] }, []);
        const { lines, seconds } = await explain(productSearchSql(PRODUCT_DEFAULTS, scope).rows);
        console.log(`[productsQueries] leaf "${path}" planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        expect(lines.join('\n')).toContain(CATEGORY_PATH_INDEX);
        const result = await searchProducts(run, PRODUCT_DEFAULTS, scope);
        expect(result.rows.length).toBeGreaterThanOrEqual(1);
        for (const row of result.rows) expect(row.categoryPath === path || row.categoryPath?.startsWith(`${path} › `), `${row.asin} under ${path}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a real custom category's paths match exactly through the path index",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        // The smallest custom category: the index assertion is about the array form, and a huge path list could legitimately
        // send the planner to the sort index instead (it would still be correct, just a different plan).
        const picked = await client.query<{ leaf_paths: string[] }>('SELECT leaf_paths FROM custom_categories ORDER BY jsonb_array_length(leaf_paths) ASC LIMIT 1');
        const paths = picked.rows[0]?.leaf_paths;
        if (!paths || paths.length === 0) return ctx.skip('no custom category to test with');
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, customCategoryIds: ['11111111-1111-4111-8111-000000000001'] }, paths);
        const { lines, seconds } = await explain(productSearchSql(PRODUCT_DEFAULTS, scope).rows);
        console.log(`[productsQueries] custom category with ${paths.length} paths planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        expect(lines.join('\n')).toContain(CATEGORY_PATH_INDEX);
        const started = performance.now();
        const result = await searchProducts(run, PRODUCT_DEFAULTS, scope);
        console.log(`[productsQueries] custom category search ran in ${((performance.now() - started) / 1000).toFixed(2)}s: ${result.rows.length} rows, ${result.total}${result.totalIsCapped ? '+' : ''} matches`);
        const set = new Set(paths);
        for (const row of result.rows) expect(set.has(row.categoryPath ?? ''), `${row.asin}'s path is in the custom category`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the largest custom category: planned and run for timing (the plan may use the sort index instead; both are correct)",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        const picked = await client.query<{ leaf_paths: string[] }>('SELECT leaf_paths FROM custom_categories ORDER BY jsonb_array_length(leaf_paths) DESC LIMIT 1');
        const paths = picked.rows[0]?.leaf_paths;
        if (!paths || paths.length === 0) return ctx.skip('no custom category to test with');
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, customCategoryIds: ['11111111-1111-4111-8111-000000000001'] }, paths);
        const { lines, seconds } = await explain(productSearchSql(PRODUCT_DEFAULTS, scope).rows);
        console.log(`[productsQueries] largest custom category (${paths.length} paths) planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        const started = performance.now();
        const result = await searchProducts(run, PRODUCT_DEFAULTS, scope);
        console.log(`[productsQueries] largest custom category search ran in ${((performance.now() - started) / 1000).toFixed(2)}s: ${result.rows.length} rows, ${result.total}${result.totalIsCapped ? '+' : ''} matches`);
        const set = new Set(paths);
        for (const row of result.rows) expect(set.has(row.categoryPath ?? ''), `${row.asin}'s path is in the custom category`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the option lists: 36-ish departments and about 22.7k distinct paths among the rows the page can show; per-department cache entries stay well under 2 MB',
    async () => {
      await inReadOnlyTransaction(async () => {
        const counts = await client.query<{ departments: number; paths: number }>(
          "SELECT count(DISTINCT category_root)::int AS departments, count(DISTINCT category_path)::int AS paths FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price')",
        );
        console.log(`[productsQueries] option lists: ${counts.rows[0].departments} departments, ${counts.rows[0].paths} paths`);
        expect(counts.rows[0].departments).toBeGreaterThanOrEqual(20);
        expect(counts.rows[0].paths).toBeGreaterThanOrEqual(10_000);
        // The per-department path list is one unstable_cache entry each (lib/products/listCategories.ts); Next skips entries over
        // 2 MB, so the largest department's list must stay well under it. est_entry ≈ the JSON size of the cached string[].
        const sizes = await client.query<{ category_root: string; paths: number; est_entry: number }>(
          "SELECT category_root, count(*)::int AS paths, sum(length(category_path) + 5)::int AS est_entry FROM (SELECT DISTINCT category_root, category_path FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL) d GROUP BY 1 ORDER BY 3 DESC LIMIT 3",
        );
        console.log(`[productsQueries] largest department entries: ${sizes.rows.map((r) => `${r.category_root}: ${r.paths} paths ≈ ${r.est_entry} chars`).join('; ')}`);
        expect(sizes.rows[0].est_entry, 'the largest department list must stay well under the 2 MB cache limit').toBeLessThan(1_500_000);
        // The per-department statement the loader runs, planned for the largest department: it is the one statement no unit test plans.
        const largest = sizes.rows[0].category_root;
        const { lines, seconds } = await explain({
          text: "SELECT DISTINCT category_path FROM asin_products WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active', 'no_price') AND (category_path = $1 OR starts_with(category_path, $2)) ORDER BY category_path",
          values: [largest, `${largest} › `],
        });
        console.log(`[productsQueries] per-department list statement for "${largest}" planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loadProduct and loadProductHistory answer for a searched ASIN',
    async () => {
      await inReadOnlyTransaction(async () => {
        const { asin, from } = await sampleAsin();
        const facts = await loadProduct(run, asin);
        expect(facts, `facts of ${asin} (first row of ${from})`).not.toBeNull();
        expect(facts?.asin).toBe(asin);
        expect(facts?.inCatalog, 'a searched ASIN is in the catalog').toBe(true);
        expect(facts?.fetched, 'a searched ASIN has been fetched').toBe(true);

        const history = await loadProductHistory(run, asin);
        expect(history.length, `snapshots of ${asin}`).toBeGreaterThanOrEqual(1);
        const times = history.map((p) => Date.parse(p.fetchedAt));
        expect(times, 'history is ascending by fetchedAt').toEqual([...times].sort((a, b) => a - b));
        console.log(`[productsQueries] ${asin} (first row of ${from}): facts found, ${history.length} snapshots`);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loadProductKeywords: every row of the searched ASIN carries weeks in top 3 and a slot',
    async (ctx) => {
      if (metaWeek === null) {
        console.log('[productsQueries] reverse table not built yet (keyword_top_asins_meta.week_end_date is null): the keyword assertions are skipped.');
        ctx.skip('reverse table not built yet');
      }
      await inReadOnlyTransaction(async () => {
        const { asin, from } = await sampleAsin();
        const result = await loadProductKeywords(run, asin);
        console.log(`[productsQueries] ${asin} (first row of ${from}): ${result.total} keywords, ${result.rows.length} listed`);
        expectKeywordRows(result);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loadProductKeywords: an ASIN from the reverse table has keywords, best rank first',
    async (ctx) => {
      if (metaWeek === null) {
        console.log('[productsQueries] reverse table not built yet (keyword_top_asins_meta.week_end_date is null): the keyword assertions are skipped.');
        ctx.skip('reverse table not built yet');
      }
      await inReadOnlyTransaction(async () => {
        // A searched ASIN may have no keywords (a new product often has none); this one certainly has at least one.
        const picked = await client.query<{ asin: string }>(
          'SELECT k.asin FROM keyword_top_asins k JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id LIMIT 1',
        );
        const asin = picked.rows[0]?.asin;
        if (!asin) throw new Error('keyword_top_asins has a built week but no row joins keyword_current_summary: the reverse table and the explorer are out of step');
        const result = await loadProductKeywords(run, asin);
        console.log(`[productsQueries] ${asin} (from the reverse table): ${result.total} keywords, ${result.rows.length} listed`);
        expect(result.total, 'keywords of a reverse-table ASIN').toBeGreaterThanOrEqual(1);
        expect(result.rows.length, 'rows listed for a reverse-table ASIN').toBeGreaterThanOrEqual(1);
        expectKeywordRows(result);
        const ranks = result.rows.map((r) => r.currentRank);
        expect(ranks, 'best keyword rank first').toEqual([...ranks].sort((a, b) => a - b));
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loadProduct answers a stub (not in the catalog, not fetched) for a reverse-table ASIN the catalog lacks',
    async (ctx) => {
      if (metaWeek === null) {
        console.log('[productsQueries] reverse table not built yet (keyword_top_asins_meta.week_end_date is null): the not-in-catalog case is skipped.');
        return ctx.skip('reverse table not built yet');
      }
      await inReadOnlyTransaction(async () => {
        // An anti join over the whole catalog's keys: give it the build's memory so the hash stays in one batch.
        await client.query("SET LOCAL work_mem = '256MB'");
        const picked = await client.query<{ asin: string }>(
          'SELECT k.asin FROM keyword_top_asins k WHERE NOT EXISTS (SELECT 1 FROM asin_products a WHERE a.asin = k.asin) LIMIT 1',
        );
        const asin = picked.rows[0]?.asin;
        if (!asin) {
          console.log('[productsQueries] every ASIN in the reverse table has a catalog row (or the table is empty): the not-in-catalog case is skipped.');
          return ctx.skip('no reverse-table ASIN lacks a catalog row');
        }
        const facts = await loadProduct(run, asin);
        console.log(`[productsQueries] ${asin} (in the reverse table, no catalog row): ${facts ? `stub with inCatalog ${facts.inCatalog}, fetched ${facts.fetched}` : 'null'}`);
        expect(facts, `facts of ${asin}`).not.toBeNull();
        expect(facts?.asin).toBe(asin);
        expect(facts?.inCatalog, 'an ASIN without a catalog row').toBe(false);
        expect(facts?.fetched, 'an ASIN without a catalog row has never been fetched').toBe(false);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loadProduct answers null for an ASIN that neither the catalog nor the reverse table has',
    async () => {
      await inReadOnlyTransaction(async () => {
        expect(await loadProduct(run, 'ZZZZZZZZZZ')).toBeNull();
      });
    },
    TEST_TIMEOUT_MS,
  );
});
