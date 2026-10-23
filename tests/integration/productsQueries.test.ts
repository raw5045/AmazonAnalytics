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
 *  - the broad-category filter (spec 2026-10-14 §6): the product's path must be one of the code's paths
 *    in ba_category_crosswalk. Ten cases, placed before the department and leaf cases (their picks scan
 *    the whole catalog and would warm what these time) and ordered cold first: the code list statement
 *    (BROAD_CATEGORY_LIST_SQL, imported; it reads only the crosswalk) runs under a 5 s cold bound and
 *    matches a distinct count; the code with the most paths plans on ba_category_crosswalk_code_idx and
 *    its path count is printed; loadProduct's facts statement carries the code of the sampled ASIN's path
 *    (checked against an independent lookup); the code with the fewest paths probes
 *    asin_products_category_path_idx and never walks the sold sort index; and six that stay under the cap:
 *    a code with a mismatched department (Pet Products in Tools & Home Improvement: the planner
 *    multiplies the two selectivities as if independent and may walk a sort index across the catalog for
 *    matches that barely exist, so it runs before any case that reads Pet Products' own products, and its
 *    EXPLAIN ANALYZE must touch under 400,000 buffer accesses, whatever the cache), the code with the most paths
 *    with its own department (the same independence assumption underestimates that overlap), a code with
 *    its department (Pet Products in Pet Supplies), the code with the most paths with a leaf pick (inside
 *    the leaf), and, last, the two picks that join the crosswalk to the catalog: the code with the most
 *    paths per sellable product (the planner's worst case: many paths, few products) and the code with
 *    the most products per path (few large paths: a path-driven plan reads all their products before
 *    sorting). Every broad search has its rows and count statements planned (both plans printed), timed
 *    apart under a local cap of twice the page's, re-run with EXPLAIN (ANALYZE, BUFFERS), and every row
 *    of its page checked to map to the code;
 *  - the keywords sort (spec 2026-10-23 §5), which reads the stored asin_products.keyword_count (migration 0056): two cases under
 *    broad category Home, the widest, descending then ascending, placed after the ten broad cases and before the department and leaf
 *    cases. Each must plan on asin_products_keyword_count_idx with no Sort node over more than a page, runs through the same broad
 *    search (both statements timed apart, each under the page's cap; the EXPLAIN ANALYZE re-run printed; every row mapped to Home),
 *    and its page's keyword counts must run in the sort's direction;
 *  - the option lists (spec 2026-10-19 §6), read from product_category_facets (migration 0055): the facets' department,
 *    path and product counts, the path count cross-checked against the live catalog scope (FACETS_SCOPE_SQL, imported)
 *    within 5 % (the facets are rebuilt weekly, so they lag it); the estimated sizes of the three largest per-department
 *    cache entries, the largest well under Next's 2 MB limit; the per-department statement planned for the largest
 *    department and asserted to read product_category_facets_department_idx with no Sort node (the index delivers path
 *    order); the departments statement planned; both then run and timed. The loaders themselves are not called
 *    (unstable_cache needs Next's request scope): their two statements are restated here (listCategories.test.ts pins
 *    the same text) and stand in for them;
 *  - the ASIN page's loaders (facts, snapshot history, keywords with weeks in top 3) answer for an ASIN
 *    taken from the search; an ASIN the reverse table has but the catalog lacks gets a stub
 *    (inCatalog false); an unknown ASIN has no facts;
 *  - after every timed case, the stored keyword counts against a fresh count of keyword_top_asins (none may differ) on a sample
 *    of up to 6,000 products: the 2,000 with the highest counts and 2,000 at count 0, both read through the 0056 partial index,
 *    and the pair table's 2,000 highest ASINs (the newest entrants). The full pass over every catalog row runs last, and only on
 *    request (PRODUCTS_FULL_COUNT_CHECK=1);
 *  - opt-in, by hand: the replay of a recorded slow search (spec 2026-10-23 §5b), PRODUCTS_REPLAY_QUERY=<query string> (a
 *    slow_queries.query_string, as the digest's "Slow product searches" lists it; an empty value is the default list, the digest's
 *    "(no filters)"), or, when that is unset, PRODUCTS_REPLAY_FILE=<path>: the string read from that file (UTF-8, trimmed), for one
 *    too long to paste (the digest shows 400 characters of a string; the row holds it whole up to 32000, beyond that cut, with a
 *    " ...[+N chars]" marker). A recorded string carries the category scope in three forms: `leaf` (repeated: each a subtree, the
 *    page's leaf pick and the search_products tool's taxonomy selection alike), `custom` (the custom-category ids, comma-joined)
 *    and `leafExact` (repeated: the tool's exact leafPaths, which the page has no form for; a replay-only key the page's parser
 *    would ignore). The leafExact values are taken out first; the rest is parsed as the list page parses its URL
 *    (parseProductFilters over the searchParams shape Next hands the page: a repeated leaf stays a list), the custom ids are
 *    expanded to their stored paths (whoever owns them: the string carries no account), and the leafExact paths join those as
 *    exact paths. The rows statement is planned (EXPLAIN), then run with EXPLAIN (ANALYZE, BUFFERS) under the local cap: the plan
 *    and the time print, and the statement must finish under the page's cap. Skipped when neither variable is set; nothing
 *    replays a recorded string automatically.
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
 *  - migration 0053 applied (checked up front: the file fails at once when ba_category_crosswalk is
 *    missing) and the crosswalk built once (scripts/buildBaCrosswalk.ts, spec 2026-10-14 §13 step 2):
 *    until it holds a row the ten broad cases skip with a note ("crosswalk not built");
 *  - migration 0055 applied (checked up front: the file fails at once when product_category_facets is missing) and the
 *    facets built once (scripts/buildProductCategoryFacets.ts, spec 2026-10-19 §13 step 3): until the table holds a row
 *    the option-lists case skips with a note ("facets not built");
 *  - migration 0056 applied (checked up front: the file fails at once when asin_products_keyword_count_idx is missing, since every
 *    search selects asin_products.keyword_count) and the keyword counts built once (scripts/buildKeywordCounts.ts, spec 2026-10-23
 *    §9): until a product the list can show has a count above 0, the stored-count cases skip with a note ("keyword counts not built
 *    yet"). The sampled check reads a few thousand rows through the 0056 index and the pair table's asin index; the full pass (a
 *    probe of the pair table for every catalog row: minutes on a cold Neon) runs only with PRODUCTS_FULL_COUNT_CHECK=1;
 *  - a custom category with stored paths (any account's; only its paths are read) for the two
 *    custom-category cases: when there is none they are skipped ("no custom category to test with");
 *  - no import running. A cold Neon can take tens of seconds for the first reads.
 *
 * Run (owner's go, Git Bash), the products file first and alone (its timings must be as cold as the run allows:
 * the crosswalk test scans the catalog and the build test's carry sorts the whole live pair table), then the
 * crosswalk test, then the build test:
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts --disableConsoleIntercept
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/baCrosswalk.test.ts --disableConsoleIntercept
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts --disableConsoleIntercept
 * In the documented run (spec 2026-10-14 §13: step 2's build, then this file) the catalog is not cold either:
 * the build's catalog-paths read scans the whole heap minutes earlier. The risky cases (the mismatched
 * department above all) are therefore judged by the work their EXPLAIN (ANALYZE, BUFFERS) re-run prints
 * (blocks hit + read, the sort-index node's rows), which does not depend on the cache, not by their times
 * alone. For the coldest index reading, run the mismatched-department case alone first:
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts -t "mismatched department" --disableConsoleIntercept
 * Likewise for the coldest reading of the keywords sort (spec 2026-10-23 §5), its two cases alone:
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts -t "keywords sort" --disableConsoleIntercept
 * The stored-count full pass is opt-in: add PRODUCTS_FULL_COUNT_CHECK=1 to the whole-file run (it runs last), or run it alone:
 *   PRODUCTS_FULL_COUNT_CHECK=1 RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts -t "every catalog row" --disableConsoleIntercept
 * The replay of a recorded slow search is opt-in too; run it alone, for the coldest reading (in a whole-file run it comes after every
 * other case but the full pass). Single quotes keep Git Bash off the & of the string; a long one goes in a file instead (the path
 * relative to the repo root):
 *   PRODUCTS_REPLAY_QUERY='broad=Home&sort=keywords' RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts -t "recorded slow search" --disableConsoleIntercept
 *   PRODUCTS_REPLAY_FILE=replay.txt RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts -t "recorded slow search" --disableConsoleIntercept
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { EMPTY_CATEGORY_SCOPE, pageCategoryScope, type ProductCategoryScope } from '@/lib/products/categoryPredicate';
import { parseProductFilters, PRODUCT_DEFAULTS, PRODUCT_PAGE_SIZE, productFiltersToSearchParams, type ProductFilters, type SearchParamsLike } from '@/lib/products/filters';
import { PRODUCT_READ_TIMEOUT_MS, productSearchSql, searchProducts, type ProductSearchResult, type ProductSummaryRow, type SqlRunner, type SqlStatement } from '@/lib/products/searchProducts';
import { BROAD_CATEGORY_LIST_SQL } from '@/lib/products/listCategories';
import { FACETS_SCOPE_SQL } from '@/lib/products/buildCategoryFacets';
import { loadProduct } from '@/lib/products/loadProduct';
import { loadProductHistory } from '@/lib/products/loadProductHistory';
import { loadProductKeywords, type ProductKeywordsResult } from '@/lib/products/loadProductKeywords';

const RUN = !!process.env.RUN_INTEGRATION;
/** The stored-count full pass (a probe of the pair table for every catalog row) runs only on request: PRODUCTS_FULL_COUNT_CHECK=1. */
const FULL_COUNT_CHECK = process.env.PRODUCTS_FULL_COUNT_CHECK === '1';
/**
 * The replay of a recorded slow search runs only on request: PRODUCTS_REPLAY_QUERY=<query string> (an empty value is the default
 * list), or, when that is unset, PRODUCTS_REPLAY_FILE=<path> (relative to the repo root, where vitest runs): the string read from
 * that file once, here, as UTF-8 and trimmed, for one too long to paste or to pass in a variable. Neither set: skipped.
 */
const REPLAY_FILE = process.env.PRODUCTS_REPLAY_FILE;
const REPLAY_QUERY = process.env.PRODUCTS_REPLAY_QUERY ?? (REPLAY_FILE ? readFileSync(REPLAY_FILE, 'utf8').trim() : undefined);
/** Per statement (see the header). */
const STATEMENT_TIMEOUT = '300s';
/** How often the server checks that the client is still there while it runs a statement. */
const CONNECTION_CHECK_INTERVAL = '10s';
const TEST_TIMEOUT_MS = 6 * 60_000;
const HOOK_TIMEOUT_MS = 2 * 60_000;
/**
 * The local cap on a timed broad read (a search, or the sampled ASIN's facts read): twice the page's own (the page stops a read at
 * PRODUCT_READ_TIMEOUT_MS), so a bad plan is cancelled here instead of running on to the 300 s statement timeout and past the case's
 * test timeout.
 */
const SEARCH_TIMEOUT = `${(PRODUCT_READ_TIMEOUT_MS * 2) / 1000}s`;

/** The six partial indexes of migration 0051: (key, asin) over the rows the Products page can show. */
const PRODUCT_SEARCH_INDEXES = [
  'asin_products_listed_since_idx',
  'asin_products_monthly_sold_idx',
  'asin_products_review_count_idx',
  'asin_products_sales_rank_idx',
  'asin_products_price_idx',
  'asin_products_rank_ratio_idx',
] as const;
/** The keywords sort's index (migration 0056): (keyword_count, asin), partial on the list's base predicate like the six above. */
const KEYWORD_COUNT_INDEX = 'asin_products_keyword_count_idx';
/** The category filter's index (migration 0050): category_path text_pattern_ops, partial on in_scope AND category_path IS NOT NULL. */
const CATEGORY_PATH_INDEX = 'asin_products_category_path_idx';
/** The broad-category filter's index (migration 0053): (code, category_path) on the crosswalk; the equality probes ride the category-path index above. */
const CROSSWALK_INDEX = 'ba_category_crosswalk_code_idx';
/** The option lists' index (migration 0055): (department, category_path) on product_category_facets. */
const FACETS_DEPARTMENT_INDEX = 'product_category_facets_department_idx';
/**
 * The two statements of lib/products/listCategories.ts (spec 2026-10-19 §6), restated: its cached callbacks inline them (the cache
 * key covers a callback's source), so there is nothing to import; listCategories.test.ts pins the same text.
 */
const DEPARTMENTS_SQL = 'SELECT DISTINCT department FROM product_category_facets ORDER BY department';
const PATHS_FOR_DEPARTMENT_SQL = 'SELECT category_path FROM product_category_facets WHERE department = $1 ORDER BY category_path';
/**
 * The list's base predicate (BASE in lib/products/searchProducts.ts), restated for the stored-count cases: the 0056 index is partial
 * on exactly it, so a statement can read that index only when its WHERE carries it.
 */
const LIST_BASE = "a.in_scope AND a.enrichment_status IN ('active', 'no_price')";
/**
 * The stored-count sample (spec 2026-10-23 §5): up to 6,000 catalog rows as (asin, keyword_count). The 2,000 with the highest counts
 * and 2,000 at count 0 are read through asin_products_keyword_count_idx, so both branches carry LIST_BASE; the catalog rows of the
 * pair table's 2,000 highest ASINs (the newest entrants) are read through keyword_top_asins_asin_idx and the catalog's primary key.
 * That third branch takes no LIST_BASE: the build writes every catalog row, so the newest entrants are compared whatever their fetch
 * status (the base predicate would drop the ones not fetched yet). The branches can overlap; a row in two is compared twice.
 */
const KEYWORD_COUNT_SAMPLE = `WITH s AS (
  (SELECT a.asin, a.keyword_count FROM asin_products a WHERE ${LIST_BASE} ORDER BY a.keyword_count DESC, a.asin DESC LIMIT 2000)
  UNION ALL
  (SELECT a.asin, a.keyword_count FROM asin_products a WHERE ${LIST_BASE} AND a.keyword_count = 0 ORDER BY a.asin LIMIT 2000)
  UNION ALL
  (SELECT a.asin, a.keyword_count FROM (SELECT DISTINCT k.asin FROM keyword_top_asins k ORDER BY k.asin DESC LIMIT 2000) t
     JOIN asin_products a ON a.asin = t.asin)
)`;

/** The owner's example search: listed within 180 days, 1,000+ sold a month, at most 300 reviews. */
const OWNER_SEARCH: ProductFilters = { ...PRODUCT_DEFAULTS, age: 180, soldMin: 1000, reviewsMax: 300 };

/** The parts of an EXPLAIN (FORMAT JSON) node these cases read. */
interface PlanNode {
  'Node Type': string;
  'Plan Rows': number;
  /** EXPLAIN ANALYZE only: the rows the node produced per loop, how many loops ran, and (with BUFFERS) the blocks its subtree hit in and read into the shared buffers. */
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  Plans?: PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
/** One line per plan node (node type, scan direction, index or relation, estimated rows; after EXPLAIN ANALYZE also actual rows and loops), indented by depth. */
function outline(node: PlanNode, depth = 0): string[] {
  const on = node['Index Name'] ?? node['Relation Name'];
  // After EXPLAIN ANALYZE: a node run once per candidate row shows as loops in the thousands, one run for the whole statement as loops=1.
  const actual = node['Actual Rows'] === undefined ? undefined : `actual=${node['Actual Rows']} loops=${node['Actual Loops']}`;
  const line = [node['Node Type'], node['Scan Direction'], on, `rows=${node['Plan Rows']}`, actual].filter(Boolean).join(' ');
  return [`${'  '.repeat(depth)}${line}`, ...(node.Plans ?? []).flatMap((child) => outline(child, depth + 1))];
}

/** What explainAnalyze reports for a statement it ran: the outline (actual rows and loops), the rows of the top node, the server's planning + execution seconds, and the shared blocks the whole statement hit and read. */
interface AnalyzedPlan { lines: string[]; rows: number; seconds: number; hit: number; read: number }

/** A query string's parameters in the shape Next hands a page its searchParams, which parseProductFilters reads: a repeated key (leaf) becomes a list. */
function toSearchParamsLike(sp: URLSearchParams): SearchParamsLike {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of sp) {
    const seen = out[key];
    out[key] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
  }
  return out;
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
    const crosswalk = await client.query<{ ok: boolean }>("SELECT to_regclass('ba_category_crosswalk') IS NOT NULL AS ok");
    if (!crosswalk.rows[0]?.ok) throw new Error('migration 0053 is not applied (ba_category_crosswalk is missing)');
    const facets = await client.query<{ ok: boolean }>("SELECT to_regclass('product_category_facets') IS NOT NULL AS ok");
    if (!facets.rows[0]?.ok) throw new Error('migration 0055 is not applied (product_category_facets is missing)');
    // Every search selects a.keyword_count (42703 without the column); the index exists only on top of it.
    const keywordCounts = await client.query<{ ok: boolean }>(`SELECT to_regclass('${KEYWORD_COUNT_INDEX}') IS NOT NULL AS ok`);
    if (!keywordCounts.rows[0]?.ok) throw new Error(`migration 0056 is not applied (${KEYWORD_COUNT_INDEX} is missing)`);
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

  /**
   * An ASIN for the loader cases: the first row of the owner's search, else of the default view. The owner's-search case records its
   * first row in `sample`, so this runs that search again only when that case did not run or matched nothing.
   */
  async function sampleAsin(): Promise<{ asin: string; from: string }> {
    if (sample) return sample;
    for (const [from, filters] of [['the owner search', OWNER_SEARCH], ['the default view', PRODUCT_DEFAULTS]] as const) {
      const first = (await searchProducts(run, filters, EMPTY_CATEGORY_SCOPE)).rows[0];
      if (first) return (sample = { asin: first.asin, from });
    }
    throw new Error('no product to sample: neither the owner search nor the default view returned a row');
  }

  /** The crosswalk is filled by its first build (spec 2026-10-14 §13 step 2); before it, the broad cases skip. */
  async function codesPresent(): Promise<boolean> {
    const r = await client.query('SELECT 1 FROM ba_category_crosswalk LIMIT 1');
    return (r.rowCount ?? 0) > 0;
  }

  /** The start of every broad case: skip it, with a note, until the crosswalk is built (ctx.skip throws, so nothing after it runs). */
  async function skipUnlessCodes(ctx: TestContext): Promise<void> {
    if (await codesPresent()) return;
    console.log('[productsQueries] crosswalk not built yet: skipped');
    ctx.skip('crosswalk not built');
  }

  /**
   * The start of the stored-count cases: skip, with a note, until the first keyword-count build (scripts/buildKeywordCounts.ts, spec
   * 2026-10-23 §9) has given a product the list can show a count above 0. The probe carries LIST_BASE, so it stops at the first entry
   * of asin_products_keyword_count_idx above 0 instead of scanning the catalog.
   */
  async function skipUnlessKeywordCounts(ctx: TestContext): Promise<void> {
    const r = await client.query<{ built: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM asin_products a WHERE ${LIST_BASE} AND a.keyword_count > 0) AS built`,
    );
    if (r.rows[0]?.built) return;
    console.log('[productsQueries] no product the list can show has a keyword_count above 0 (the keyword-count backfill, scripts/buildKeywordCounts.ts, has not run): skipped');
    ctx.skip('keyword counts not built yet');
  }

  /**
   * The code with the most paths: the planner's first most-common value of ba_category_crosswalk.code (pg_stats; the build
   * analyzes the table), else a count over the 24k-row table. Neither touches the catalog, so the search timed next is not
   * warmed by the pick.
   */
  async function codeWithMostPaths(): Promise<string> {
    const stat = await client.query<{ v: string | null }>(
      "SELECT (most_common_vals::text::text[])[1] AS v FROM pg_stats WHERE schemaname = current_schema() AND tablename = 'ba_category_crosswalk' AND attname = 'code'",
    );
    if (stat.rows[0]?.v) return stat.rows[0].v;
    const counted = await client.query<{ code: string }>('SELECT code FROM ba_category_crosswalk GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1');
    return counted.rows[0].code;
  }

  /** Sellable products of a code (a join over the catalog: run only AFTER a timed read, it warms the pages). */
  async function productsOf(code: string): Promise<number> {
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM asin_products a JOIN ba_category_crosswalk x ON x.category_path = a.category_path
       WHERE x.code = $1 AND a.in_scope AND a.enrichment_status IN ('active', 'no_price')`,
      [code],
    );
    return r.rows[0].n;
  }

  /**
   * EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of a page statement. Unlike explain() it RUNS the statement (a read, so fine in this
   * transaction) and reports the server's own planning plus execution time (the clock the page's statement cap runs on), the rows
   * the top node produced, and the blocks it hit in and read into the shared buffers (reads = misses in shared buffers; Neon's local
   * file cache may still serve them). The outline carries each node's actual rows and loops.
   */
  async function explainAnalyze(q: SqlStatement): Promise<AnalyzedPlan> {
    const res = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`, q.values);
    const raw = res.rows[0]['QUERY PLAN'];
    const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }>;
    const root = plan[0].Plan;
    return {
      lines: outline(root),
      rows: root['Actual Rows'] ?? 0,
      seconds: (plan[0]['Planning Time'] + plan[0]['Execution Time']) / 1000,
      hit: root['Shared Hit Blocks'] ?? 0,
      read: root['Shared Read Blocks'] ?? 0,
    };
  }

  /**
   * One broad-category search (spec 2026-10-14 §6), under the default sort unless `order` names another (the keywords-sort cases of
   * spec 2026-10-23 §5; the log lines then carry the sort); `note` says how warm it runs, when that is known, and
   * `scope` adds a department or a leaf pick (the default adds none). Both statements are planned (EXPLAIN, so the plans print even if the count
   * later aborts the transaction). The search runs for real through searchProducts under a local SEARCH_TIMEOUT, with its rows
   * statement and its count statement timed apart (they run back to back on this one connection, while the page runs them in
   * parallel with a cap each) and each held to the page's cap. The rows statement is then re-run with EXPLAIN (ANALYZE, BUFFERS),
   * whose loop counts tell a probe of the crosswalk per candidate (a nested-loop walk of the sort index) from one read of the
   * code's paths (the path-set-first plan), which a plain plan outline cannot; the local cap stays on through that re-run, so a
   * bad plan cannot outlive the case there either. Last, every row of the page is checked to map to the code, whatever plan
   * served it. It returns the planned rows plan (its root and outline), the page's rows and the re-run's result (`analyzed`), whose
   * blocks hit + read are a verdict that does not depend on the cache.
   */
  async function broadSearch(
    code: string,
    note?: string,
    scope: ProductCategoryScope = EMPTY_CATEGORY_SCOPE,
    order: Pick<ProductFilters, 'sort' | 'dir'> = PRODUCT_DEFAULTS,
  ): Promise<{ root: PlanNode; lines: string[]; rows: ProductSummaryRow[]; analyzed: AnalyzedPlan }> {
    const cap = PRODUCT_READ_TIMEOUT_MS / 1000;
    const filters: ProductFilters = { ...PRODUCT_DEFAULTS, sort: order.sort, dir: order.dir, broadCategory: code };
    // How the log lines and messages name this search: the code, plus the sort when it is not the default one.
    const name = order.sort === PRODUCT_DEFAULTS.sort && order.dir === PRODUCT_DEFAULTS.dir ? `"${code}"` : `"${code}" sorted by ${order.sort} ${order.dir}`;
    const q = productSearchSql(filters, scope);
    const planned = await explain(q.rows);
    console.log(`[productsQueries] broad category ${name} rows plan (planned in ${planned.seconds.toFixed(2)}s):\n${planned.lines.join('\n')}`);
    const countPlanned = await explain(q.count);
    console.log(`[productsQueries] broad category ${name} count plan (planned in ${countPlanned.seconds.toFixed(2)}s):\n${countPlanned.lines.join('\n')}`);

    // searchProducts sends both statements at once and the connection runs them in order: note when each completes, and each one's
    // own time is the gap since the one before it finished.
    const finished: Array<{ statement: 'rows' | 'count'; at: number }> = [];
    const timedRun: SqlRunner = async (text, values) => {
      try {
        return await run(text, values);
      } finally {
        finished.push({ statement: text === q.count.text ? 'count' : 'rows', at: performance.now() });
      }
    };
    await client.query(`SET LOCAL statement_timeout = '${SEARCH_TIMEOUT}'`);
    const started = performance.now();
    let result: ProductSearchResult;
    try {
      result = await searchProducts(timedRun, filters, scope);
    } catch (e) {
      // searchProducts swallows a count cancelled by the cap, so a statement timeout (SQLSTATE 57014, query_canceled) that gets out is
      // the rows statement's; any other error is left as it is.
      if ((e as { code?: unknown } | null)?.code !== '57014') throw e;
      throw new Error(`the rows statement of ${name} hit the local ${SEARCH_TIMEOUT} cap (the page's is ${cap}s) after ${((performance.now() - started) / 1000).toFixed(1)}s`, { cause: e });
    }
    const seconds = { rows: 0, count: 0 };
    let previous = started;
    for (const done of finished) {
      seconds[done.statement] = (done.at - previous) / 1000;
      previous = done.at;
    }
    console.log(
      `[productsQueries] broad category ${name} search${note ? `, ${note}` : ''}: rows statement ${seconds.rows.toFixed(2)}s, count statement ${seconds.count.toFixed(2)}s ` +
        `(the page's cap is ${cap}s each), countTimedOut ${result.countTimedOut === true}; ${result.rows.length} rows on page ${result.page}, ${result.total}${result.totalIsCapped ? '+' : ''} matches`,
    );
    const over = (['rows', 'count'] as const).filter((statement) => seconds[statement] >= cap);
    if (over.length > 0) console.log(`[productsQueries] OVER THE PAGE'S ${cap}s CAP: the ${over.join(' and the ')} statement of the ${name} search`);
    // searchProducts swallows a count cancelled by the local cap, but the cancelled statement aborted this transaction: nothing more can run in it.
    if (result.countTimedOut) {
      throw new Error(`the count statement of the ${name} search hit the local ${SEARCH_TIMEOUT} cap (the page's is ${cap}s) and aborted the transaction; its rows statement took ${seconds.rows.toFixed(1)}s`);
    }

    // The rows statement again (warm now): what each node really did, and how many times.
    const analyzed = await explainAnalyze(q.rows);
    console.log(
      `[productsQueries] broad category ${name} rows statement re-run with EXPLAIN ANALYZE (warm): ${analyzed.seconds.toFixed(2)}s planning + execution, ${analyzed.rows} rows, ` +
        `shared blocks hit ${analyzed.hit}, read ${analyzed.read}:\n${analyzed.lines.join('\n')}`,
    );
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const without = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) r(asin) JOIN asin_products a ON a.asin = r.asin
       LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path WHERE x.code IS DISTINCT FROM $2`,
      [result.rows.map((r) => r.asin), code],
    );
    expect(without.rows[0].n, `rows of the ${name} page whose path does not map to the code`).toBe(0);
    expect(seconds.rows, `rows statement of the ${name} search (the page's cap is ${cap}s)`).toBeLessThan(cap);
    expect(seconds.count, `count statement of the ${name} search (the page's cap is ${cap}s)`).toBeLessThan(cap);
    return { root: planned.root, lines: planned.lines, rows: result.rows, analyzed };
  }

  /**
   * The keywords sort under broad category Home (spec 2026-10-23 §5), in one direction: the combination that ran past the page's cap
   * cold while the sort counted keywords with a lateral per candidate row (~315k probes for Home, the widest broad category; spec
   * 2026-10-12 §13). With the stored keyword_count it must plan on asin_products_keyword_count_idx with no Sort node over more than a
   * page (the top-N comes off the index walk, as in the default-view case), and broadSearch holds its rows and count statements each
   * under the page's cap and prints their seconds. The index is partial (WHERE in_scope AND enrichment_status IN ('active',
   * 'no_price')), so the planner can use it only because the query carries that predicate: the list's base predicate (BASE in
   * lib/products/searchProducts.ts) is exactly it, so nothing extra is needed. The page's keyword counts are checked to run in the
   * sort's direction. Skipped with a note when the crosswalk is not built or has no Home code.
   */
  async function keywordsSortUnderHome(ctx: TestContext, dir: ProductFilters['dir']): Promise<void> {
    await skipUnlessCodes(ctx);
    const present = await client.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM ba_category_crosswalk WHERE code = 'Home') AS ok");
    if (!present.rows[0]?.ok) {
      console.log('[productsQueries] no Home code in the crosswalk: the keywords-sort case is skipped.');
      return ctx.skip('no Home code in the crosswalk');
    }
    const { root, lines, rows } = await broadSearch('Home', `the keywords sort, ${dir}`, EMPTY_CATEGORY_SCOPE, { sort: 'keywords', dir });
    expect(lines.join('\n'), `the plan of the Home search sorted by keywords ${dir}`).toContain(KEYWORD_COUNT_INDEX);
    const wideSorts = planNodes(root).filter((n) => /Sort$/.test(n['Node Type']) && n['Plan Rows'] > PRODUCT_PAGE_SIZE);
    expect(wideSorts.map((n) => `${n['Node Type']} rows=${n['Plan Rows']}`), `Sort nodes over more than a page (${PRODUCT_PAGE_SIZE} rows)`).toEqual([]);
    expect(rows.length, `rows on the Home page sorted by keywords ${dir}`).toBeGreaterThanOrEqual(1);
    const counts = rows.map((r) => r.keywordCount);
    console.log(`[productsQueries] Home sorted by keywords ${dir}: the page's keyword counts run ${counts[0]} → ${counts[counts.length - 1]}`);
    if (dir === 'desc' && counts.every((c) => c === 0)) console.log('[productsQueries] every keyword count on the descending page is 0: has the keyword-count build (scripts/buildKeywordCounts.ts) run?');
    expect(counts, `the page's keyword counts, ${dir}`).toEqual([...counts].sort((x, y) => (dir === 'asc' ? x - y : y - x)));
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
        // The loader cases sample this page's first row (sampleAsin reads `sample` first), so they do not run the search, and its count, again.
        if (result.rows[0]) sample = { asin: result.rows[0].asin, from: 'the owner search' };

        expect(result.rows.length, 'rows on the page').toBeLessThanOrEqual(PRODUCT_PAGE_SIZE);
        for (const row of result.rows) expect(row.asin, 'asin of a result row').toHaveLength(10);
        expect(result.total, 'total matches').toBeGreaterThanOrEqual(result.rows.length);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the code list statement runs inside the 5 s cold bound and lists every distinct code',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const started = performance.now();
        const listed = await client.query<{ code: string }>(BROAD_CATEGORY_LIST_SQL);
        const seconds = (performance.now() - started) / 1000;
        console.log(`[productsQueries] broad category list: ${listed.rows.length} codes in ${seconds.toFixed(2)}s (the cold bound is 5s)`);
        const distinct = await client.query<{ n: number }>('SELECT count(DISTINCT code)::int AS n FROM ba_category_crosswalk');
        expect(listed.rows.length, 'codes the list statement returns, against the distinct codes on the table').toBe(distinct.rows[0].n);
        expect(seconds, 'the code list statement (the cold bound)').toBeLessThan(5);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the code with the most paths under the default sort plans on the crosswalk index and every row maps to the code',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const code = await codeWithMostPaths();
        const { lines, rows } = await broadSearch(code);
        // The code's size, from the crosswalk alone (no catalog read), for the Results table ("most paths: X (N)").
        const size = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM ba_category_crosswalk WHERE code = $1', [code]);
        console.log(`[productsQueries] code with the most paths "${code}": ${size.rows[0].n} paths`);
        expect(lines.join('\n'), `the plan of the "${code}" search`).toContain(CROSSWALK_INDEX);
        expect(rows.length, `rows on the "${code}" page`).toBeGreaterThanOrEqual(1);
        expect(rows.length, `rows on the "${code}" page`).toBeLessThanOrEqual(PRODUCT_PAGE_SIZE);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "loadProduct carries the code of the sampled ASIN's path, as an independent lookup of the crosswalk gives it",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const { asin, from } = await sampleAsin();
        await client.query(`SET LOCAL statement_timeout = '${SEARCH_TIMEOUT}'`);
        const started = performance.now();
        const facts = await loadProduct(run, asin);
        const seconds = (performance.now() - started) / 1000;
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        const expected = await client.query<{ code: string | null }>(
          'SELECT x.code FROM asin_products a LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path WHERE a.asin = $1',
          [asin],
        );
        console.log(`[productsQueries] ${asin} (${from}): path ${facts?.categoryPath ?? 'none'} → broadCategory ${facts?.broadCategory ?? 'null'} in ${seconds.toFixed(3)}s`);
        // A path with no crosswalk row reads null on both sides of the check below; say so, so that a pass on null = null is not mistaken for a mapped one.
        if ((facts?.categoryPath ?? null) !== null && (expected.rows[0]?.code ?? null) === null) console.log(`[productsQueries] ${asin}: path present but unmapped (the check compared null with null)`);
        expect(facts, `facts of ${asin}`).not.toBeNull();
        expect(facts?.broadCategory ?? null, `the code of ${asin}`).toBe(expected.rows[0]?.code ?? null);
        expect(seconds, `the facts read of ${asin}`).toBeLessThan(PRODUCT_READ_TIMEOUT_MS / 1000);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the code with the fewest paths probes the category-path index and never walks the sold sort index",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const picked = await client.query<{ code: string; paths: number }>('SELECT code, count(*)::int AS paths FROM ba_category_crosswalk GROUP BY 1 ORDER BY 2, 1 LIMIT 1');
        const { code, paths } = picked.rows[0];
        console.log(`[productsQueries] code with the fewest paths: "${code}", ${paths} path(s)`);
        const { lines, rows } = await broadSearch(code);
        const plan = lines.join('\n');
        expect(plan, `the plan of the "${code}" search`).toContain(CATEGORY_PATH_INDEX);
        expect(plan, `the plan of the "${code}" search must not walk the sold sort index`).not.toContain('asin_products_monthly_sold_idx');
        const products = await productsOf(code);
        console.log(`[productsQueries] "${code}": ${products} sellable products`);
        expect(rows.length, `rows on the page of "${code}"`).toBeLessThanOrEqual(products);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a code with a mismatched department (Pet Products in Tools & Home Improvement) stays under the cap',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The planner multiplies the code's and the department's selectivities as if they were independent, so for a code that barely
        // occurs in the department it may walk a sort index across the catalog looking for matches that hardly exist: the likeliest cold
        // case to pass the page's cap, so it runs before the cases that read the catalog (any that reads Pet Products' own products, and
        // the two picks that join the crosswalk to it); the code picks above it read only the crosswalk. The three searches executed
        // above it (the owner's, the most-paths code's and the fewest-paths code's) read the catalog too, and in the documented run the
        // build of spec §13 step 2 scanned the whole heap minutes earlier, so the verdict rests on the work the EXPLAIN ANALYZE re-run
        // prints (the buffer accesses checked at the end), not on the time alone. For the coldest index reading run this case alone
        // first (-t "mismatched department").
        const present = await client.query<{ pets: boolean; tools: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ba_category_crosswalk WHERE code = 'Pet Products') AS pets,
                  EXISTS (SELECT 1 FROM asin_products WHERE in_scope AND starts_with(category_path, 'Tools & Home Improvement › ')) AS tools`,
        );
        if (!present.rows[0]?.pets || !present.rows[0]?.tools) {
          console.log(`[productsQueries] ${present.rows[0]?.pets ? 'no path under Tools & Home Improvement' : 'no Pet Products code'}: the mismatched-department case is skipped.`);
          return ctx.skip('no Pet Products code or no path under Tools & Home Improvement');
        }
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, dept: 'Tools & Home Improvement' }, []);
        const { rows, analyzed } = await broadSearch('Pet Products', 'with a mismatched department', scope);
        // An empty page is a valid answer here: this case asserts the times (inside broadSearch), the department of every row and the
        // buffer accesses of the EXPLAIN ANALYZE re-run (below), and prints the plans.
        console.log(`[productsQueries] Pet Products in Tools & Home Improvement: the page holds ${rows.length} rows`);
        for (const r of rows) expect(r.categoryPath === 'Tools & Home Improvement' || r.categoryPath?.startsWith('Tools & Home Improvement › '), `department of ${r.asin}`).toBe(true);
        // The cache-independent verdict, in buffer accesses (EXPLAIN's shared blocks hit + read count every access, not distinct
        // blocks). Measured 2026-10-14: the sold index holds 768,076 entries with the badge, so a walk across the catalog that finds
        // almost nothing fetches at least one heap block per entry (780,000+ accesses); Tools & Home Improvement holds 63,590 rows
        // (38,650 in the default view), so a department-driven plan with a hashed crosswalk touches about 65,000–130,000, a nested-loop
        // probe per row up to ~260,000, and a crosswalk-driven plan about Pet Products' own products (~50,000). The bound sits between
        // the two shapes; recalibrate it from the numbers printed above if the catalog changes shape. A sold walk that fills the page
        // early (50+ matches, a full page, with the badge inside the department) would pass the bound too; the printed plan shows the shape.
        expect(analyzed.hit + analyzed.read, 'buffer accesses of the mismatched search (the BUFFERS keys were read)').toBeGreaterThan(0);
        expect(analyzed.hit + analyzed.read, 'buffer accesses of the mismatched search (cache-independent)').toBeLessThan(400_000);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the code with the most paths, with its own department (picked from the crosswalk), stays under the cap and inside the department',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The planner multiplies the code's and the department's selectivities as if they were independent and underestimates this
        // overlap (most of the code's products sit in its own department), which pushes it toward reading every product of the code in
        // the department before the top-N sort. Picked from the crosswalk alone (no catalog read), so the pick does not warm the search.
        const code = await codeWithMostPaths();
        const picked = await client.query<{ dept: string; paths: number }>(
          "SELECT split_part(category_path, ' › ', 1) AS dept, count(*)::int AS paths FROM ba_category_crosswalk WHERE code = $1 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1",
          [code],
        );
        const own = picked.rows[0];
        if (!own) {
          console.log(`[productsQueries] "${code}" has no path in the crosswalk: the own-department case is skipped.`);
          return ctx.skip(`no crosswalk path for "${code}"`);
        }
        const { dept, paths } = own;
        console.log(`[productsQueries] "${code}": its own department is "${dept}" (${paths} of its paths)`);
        const { rows } = await broadSearch(code, 'with its own department', pageCategoryScope({ ...PRODUCT_DEFAULTS, dept }, []));
        console.log(`[productsQueries] "${code}" in "${dept}": ${rows.length} rows on the page`);
        expect(rows.length, `rows of "${code}" in "${dept}"`).toBeGreaterThanOrEqual(1);
        for (const r of rows) expect(r.categoryPath === dept || r.categoryPath?.startsWith(`${dept} › `), `department of ${r.asin}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a code with its department (Pet Products in Pet Supplies) stays under the cap and returns rows',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const present = await client.query<{ ok: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM ba_category_crosswalk WHERE code = 'Pet Products' AND category_path LIKE 'Pet Supplies › %') AS ok",
        );
        if (!present.rows[0]?.ok) {
          console.log('[productsQueries] no Pet Supplies path maps to Pet Products: the department case is skipped.');
          return ctx.skip('no Pet Products path under Pet Supplies');
        }
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' }, []);
        const { rows } = await broadSearch('Pet Products', 'with the Pet Supplies department', scope);
        console.log(`[productsQueries] Pet Products in Pet Supplies: ${rows.length} rows on the page`);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        for (const r of rows) expect(r.categoryPath === 'Pet Supplies' || r.categoryPath?.startsWith('Pet Supplies › '), `department of ${r.asin}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the code with the most paths, with a leaf pick (its best-voted self-decided path, three levels or deeper), returns rows inside the leaf and stays under the cap',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // Picked from the crosswalk alone (no catalog read), so the pick does not warm the timed search. It runs after the department
        // cases, so the pages it reads are warm (hence the note on its search).
        const code = await codeWithMostPaths();
        const picked = await client.query<{ category_path: string }>(
          `SELECT category_path FROM ba_category_crosswalk WHERE code = $1 AND source_path = category_path AND category_path LIKE '% › % › %'
           ORDER BY votes DESC, category_path LIMIT 1`,
          [code],
        );
        const leaf = picked.rows[0]?.category_path;
        if (!leaf) {
          console.log(`[productsQueries] no self-decided path of "${code}" three levels deep: the leaf case is skipped.`);
          return ctx.skip(`no self-decided path of "${code}" three levels deep`);
        }
        const { rows } = await broadSearch(code, 'warm (after the department cases)', pageCategoryScope({ ...PRODUCT_DEFAULTS, leafPaths: [leaf] }, []));
        console.log(`[productsQueries] "${code}" within "${leaf}": ${rows.length} rows on the page`);
        // The code's size: a join over all its products, so it runs here, after the timed reads of this case and of the mismatched- and own-department cases above, not in the first case.
        console.log(`[productsQueries] code with the most paths "${code}": ${await productsOf(code)} sellable products`);
        // A self-decided path has 20+ training products at or below it (own-decided: with exactly that path), so its page should not be empty; if this fails, none
        // of them shows in the default view (no sold badge, or out of scope): pick another leaf by hand, it is not a predicate bug.
        expect(rows.length, `rows of "${code}" inside the leaf "${leaf}"`).toBeGreaterThanOrEqual(1);
        for (const r of rows) expect(r.categoryPath === leaf || r.categoryPath?.startsWith(`${leaf} › `), `${r.asin} under ${leaf}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the code with the most paths per sellable product (many paths, few products) stays under the page's cap",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The planner's worst case: the semi-join's estimate rests on the code's path count, so a code with many paths and few
        // products may be planned like a large one. The pick joins the catalog (warm pages), so the times printed are warm ones.
        await client.query("SET LOCAL work_mem = '256MB'");
        const picked = await client.query<{ code: string; paths: number; products: number }>(
          `SELECT x.code, count(DISTINCT x.category_path)::int AS paths, count(a.asin)::int AS products
           FROM ba_category_crosswalk x
           LEFT JOIN asin_products a ON a.category_path = x.category_path AND a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL
           GROUP BY 1 HAVING count(DISTINCT x.category_path) >= 50
           ORDER BY count(a.asin)::float / count(DISTINCT x.category_path) ASC, count(DISTINCT x.category_path) DESC LIMIT 1`,
        );
        await client.query('SET LOCAL work_mem TO DEFAULT');
        const worst = picked.rows[0];
        if (!worst) {
          console.log('[productsQueries] no code has 50 paths: the many-paths case is skipped.');
          return ctx.skip('no code with 50 paths');
        }
        console.log(`[productsQueries] most paths per product: "${worst.code}", ${worst.paths} paths, ${worst.products} sellable products with the badge`);
        const { rows } = await broadSearch(worst.code, 'warm (the pick read the same pages)');
        console.log(`[productsQueries] "${worst.code}": the page holds ${rows.length} rows`);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the code with the most products per path (few large paths) stays under the page's cap",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The mirror of the most-paths-per-sellable-product case above, the other end of the same ratio: a code whose few paths hold many
        // products. A path-driven plan reads all of them before it can sort, where a walk of the sort index would stop at the first page.
        // Same pick and floor (50 paths), same work_mem for the join; the pick reads the pages the search reads, so the times printed
        // are warm ones.
        await client.query("SET LOCAL work_mem = '256MB'");
        const picked = await client.query<{ code: string; paths: number; products: number }>(
          `SELECT x.code, count(DISTINCT x.category_path)::int AS paths, count(a.asin)::int AS products
           FROM ba_category_crosswalk x
           LEFT JOIN asin_products a ON a.category_path = x.category_path AND a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL
           GROUP BY 1 HAVING count(DISTINCT x.category_path) >= 50
           ORDER BY count(a.asin)::float / count(DISTINCT x.category_path) DESC, count(DISTINCT x.category_path) DESC LIMIT 1`,
        );
        await client.query('SET LOCAL work_mem TO DEFAULT');
        const worst = picked.rows[0];
        if (!worst) {
          console.log('[productsQueries] no code has 50 paths: the few-large-paths case is skipped.');
          return ctx.skip('no code with 50 paths');
        }
        console.log(`[productsQueries] most products per path: "${worst.code}", ${worst.paths} paths, ${worst.products} sellable products with the badge`);
        const { rows } = await broadSearch(worst.code, 'warm (the pick read the same pages)');
        console.log(`[productsQueries] "${worst.code}": the page holds ${rows.length} rows`);
      });
    },
    TEST_TIMEOUT_MS,
  );

  // The keywords sort reads the stored keyword_count (spec 2026-10-23 §5). These two run after the broad cases above (so those run as
  // warm as they always have) and before the department and leaf picks, whose catalog scans would warm what these time. Nothing above
  // reads asin_products_keyword_count_idx, so its pages are as cold as the run allows; the heap pages of Home's popular products are
  // not (the sold sort above reads many of the same products). For the coldest reading run them alone first (-t "keywords sort", see
  // the header).
  it(
    'the keywords sort under the widest broad category walks the keyword_count index and stays under the cap cold',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await keywordsSortUnderHome(ctx, 'desc');
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the keywords sort ascending under the widest broad category walks the keyword_count index too and stays under the cap',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        // A forward walk starts at count 0. The index is partial on the base predicate, so the rows the list cannot show (retired and
        // out-of-scope products are never deleted, and most sit at count 0) are not in it: the walk meets only rows the list can show.
        await keywordsSortUnderHome(ctx, 'asc');
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
    'the option lists (spec 2026-10-19 §6): the facets hold 36-ish departments and about 23k paths, within 5 % of the live catalog scope; per-department cache entries stay well under 2 MB; the per-department statement is an index read in path order, no sort',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        const facets = await client.query<{ departments: number; paths: number; products: number }>(
          'SELECT count(DISTINCT department)::int AS departments, count(*)::int AS paths, coalesce(sum(product_count), 0)::int AS products FROM product_category_facets',
        );
        if (facets.rows[0].paths === 0) {
          console.log('[productsQueries] option lists: product_category_facets is empty (not built yet: scripts/buildProductCategoryFacets.ts) — skipped');
          return ctx.skip('facets not built');
        }
        // The facets lag the live catalog by up to a week (the Keepa service adds paths daily): allow 5 % drift either way.
        const catalog = await client.query<{ departments: number; paths: number }>(
          `SELECT count(DISTINCT category_root)::int AS departments, count(DISTINCT category_path)::int AS paths FROM asin_products WHERE ${FACETS_SCOPE_SQL}`,
        );
        console.log(
          `[productsQueries] option lists: facets ${facets.rows[0].departments} departments, ${facets.rows[0].paths} paths, ${facets.rows[0].products} products; live catalog ${catalog.rows[0].departments} / ${catalog.rows[0].paths}`,
        );
        expect(facets.rows[0].departments, 'departments in the facets').toBeGreaterThanOrEqual(20);
        expect(facets.rows[0].paths, 'paths in the facets').toBeGreaterThanOrEqual(10_000);
        expect(Math.abs(facets.rows[0].paths - catalog.rows[0].paths) / catalog.rows[0].paths, "the facets' path count against the live catalog scope's (relative drift)").toBeLessThan(0.05);
        // Each department's path list is one unstable_cache entry (lib/products/listCategories.ts); Next skips entries over 2 MB,
        // so the largest must stay well under it. est_entry ≈ the size Next measures (the entry's JSON, whose body is the list's own
        // JSON): each path's length plus 5, its two escaped quotes and a comma.
        const sizes = await client.query<{ department: string; paths: number; est_entry: number }>(
          'SELECT department, count(*)::int AS paths, sum(length(category_path) + 5)::int AS est_entry FROM product_category_facets GROUP BY 1 ORDER BY 3 DESC LIMIT 3',
        );
        console.log(`[productsQueries] largest department entries: ${sizes.rows.map((r) => `${r.department}: ${r.paths} paths ≈ ${r.est_entry} chars`).join('; ')}`);
        expect(sizes.rows[0].est_entry, 'the largest department list must stay well under the 2 MB cache limit').toBeLessThan(1_500_000);
        // The two statements lib/products/listCategories.ts runs, planned (the per-department one for the largest department) and timed.
        const largest = sizes.rows[0].department;
        const perDept = await explain({ text: PATHS_FOR_DEPARTMENT_SQL, values: [largest] });
        // The read is index-only, so the planner prices it low only when the visibility map marks the pages all-visible (the build's
        // VACUUM marks them). Printed with the plan: a Seq Scan + Sort over few all-visible pages points at that VACUUM, not the readers.
        const visible = await client.query<{ relpages: number; relallvisible: number }>(
          "SELECT relpages, relallvisible FROM pg_class WHERE oid = 'product_category_facets'::regclass",
        );
        console.log(
          `[productsQueries] per-department list statement for "${largest}" planned in ${perDept.seconds.toFixed(2)}s ` +
            `(all-visible pages per the planner: ${visible.rows[0].relallvisible} of ${visible.rows[0].relpages}):\n${perDept.lines.join('\n')}`,
        );
        // An index read in path order: a node reads the department index and none sorts, since the index hands back the department's
        // paths in order (an Incremental Sort's type ends in "Sort" too, so it counts).
        const nodes = planNodes(perDept.root);
        expect(nodes.map((n) => n['Index Name']), `indexes in the plan of the per-department statement for "${largest}"`).toContain(FACETS_DEPARTMENT_INDEX);
        expect(
          nodes.filter((n) => /Sort$/.test(n['Node Type'])).map((n) => `${n['Node Type']} rows=${n['Plan Rows']}`),
          `Sort nodes in the plan of the per-department statement for "${largest}"`,
        ).toEqual([]);
        const departments = await explain({ text: DEPARTMENTS_SQL, values: [] });
        console.log(`[productsQueries] departments statement planned in ${departments.seconds.toFixed(2)}s:\n${departments.lines.join('\n')}`);
        const started = performance.now();
        await client.query(PATHS_FOR_DEPARTMENT_SQL, [largest]);
        await client.query(DEPARTMENTS_SQL);
        console.log(`[productsQueries] both list statements ran in ${((performance.now() - started) / 1000).toFixed(3)}s`);
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

  it(
    'the stored keyword counts agree with a fresh count on a sample of up to 6,000 products',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        // After every timed case. keyword_top_asins changes only at imports and keyword_counts_build rewrites the counts right after
        // top_asins_build inside the import (the import's enqueue, the only writer of new catalog rows, runs before both), so between
        // imports the two agree exactly (no import may be running, see the header); a mismatch means that phase failed or was skipped
        // ("[keyword-counts] failed" in the import log; scripts/buildKeywordCounts.ts re-runs it). The sample (KEYWORD_COUNT_SAMPLE)
        // covers the highest counts, products at count 0 (what the zeroing writes) and the pair table's newest entrants, one probe of
        // keyword_top_asins_asin_idx each: a few thousand rows, not the catalog. A failure lists up to 20 as { asin, stored, fresh }.
        await skipUnlessKeywordCounts(ctx);
        const started = performance.now();
        const size = await client.query<{ sampled: number; products: number }>(
          `${KEYWORD_COUNT_SAMPLE} SELECT count(*)::int AS sampled, count(DISTINCT s.asin)::int AS products FROM s`,
        );
        const mismatched = await client.query<{ asin: string; stored: number; fresh: number }>(
          `${KEYWORD_COUNT_SAMPLE}
           SELECT s.asin, s.keyword_count AS stored, c.n AS fresh FROM s
           CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM keyword_top_asins k WHERE k.asin = s.asin) c
           WHERE s.keyword_count <> c.n LIMIT 20`,
        );
        console.log(
          `[productsQueries] stored keyword counts against a fresh count: ${size.rows[0].sampled} sampled rows (${size.rows[0].products} products), ` +
            `${mismatched.rows.length} mismatched (listed up to 20) in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
        expect(size.rows[0].products, 'products in the sample').toBeGreaterThan(0);
        expect(mismatched.rows, 'sampled products whose stored keyword_count differs from a fresh count of keyword_top_asins').toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(REPLAY_QUERY === undefined)(
    'opt-in (PRODUCTS_REPLAY_QUERY=<query string>, or PRODUCTS_REPLAY_FILE=<path>): a recorded slow search, replayed with EXPLAIN (ANALYZE), finishes its rows statement under the page cap',
    async () => {
      await inReadOnlyTransaction(async () => {
        // The reproduction loop of spec 2026-10-23 §5b: the string the digest lists, parsed as the list page parses its URL.
        const query = REPLAY_QUERY ?? '';
        const params = new URLSearchParams(query);
        // The search_products tool's exact leaf paths (leafExact, which the page has no form for) come out first, so the parser sees
        // the page's own string; they join the exact paths below.
        const leafExact = [...new Set(params.getAll('leafExact'))];
        params.delete('leafExact');
        const filters = parseProductFilters(toSearchParamsLike(params));
        // The page expands its custom ids for the signed-in account; the recorded string carries none, so each id expands to its
        // stored paths whoever owns it (the page offers an account only its own categories, and the tool refuses anyone else's).
        const customPaths = filters.customCategoryIds.length === 0
          ? []
          : (await client.query<{ leaf_paths: string[] | null }>('SELECT leaf_paths FROM custom_categories WHERE id = ANY($1::uuid[])', [filters.customCategoryIds])).rows.flatMap((r) => r.leaf_paths ?? []);
        // pageCategoryScope builds a fresh, unfrozen object (its arrays copied), so its fields spread; the two that leafExact extends are replaced.
        const pageScope = pageCategoryScope(filters, customPaths);
        const scope: ProductCategoryScope = { ...pageScope, exactPaths: [...new Set([...customPaths, ...leafExact])], scoped: pageScope.scoped || leafExact.length > 0 };
        const q = productSearchSql(filters, scope);
        const cap = PRODUCT_READ_TIMEOUT_MS / 1000;
        // Parsing drops a value the page would drop (a bad one falls back to its default): the re-serialised string, against the
        // recorded one without leafExact and in any order (the tool appends its category groups after the page filters), shows that.
        const parsed = productFiltersToSearchParams(filters);
        const pairs = (sp: URLSearchParams): string => JSON.stringify([...sp].map((pair) => JSON.stringify(pair)).sort());
        console.log(
          `[productsQueries] replay of "${query}": parsed as "${parsed.toString()}"${pairs(parsed) === pairs(params) ? '' : ' (differs from the recorded string)'}` +
            `${filters.customCategoryIds.length > 0 ? `; ${filters.customCategoryIds.length} custom categories, ${customPaths.length} stored paths` : ''}` +
            `; ${leafExact.length} leafExact paths`,
        );
        const planned = await explain(q.rows);
        console.log(`[productsQueries] replay rows plan (planned in ${planned.seconds.toFixed(2)}s):\n${planned.lines.join('\n')}`);
        // Under the local cap (twice the page's), so a plan that is still slow is cancelled here, not at the 300 s statement timeout.
        await client.query(`SET LOCAL statement_timeout = '${SEARCH_TIMEOUT}'`);
        const analyzed = await explainAnalyze(q.rows).catch((e: unknown) => {
          if ((e as { code?: unknown } | null)?.code !== '57014') throw e;
          throw new Error(`the replayed rows statement hit the local ${SEARCH_TIMEOUT} cap (the page's is ${cap}s)`, { cause: e });
        });
        console.log(
          `[productsQueries] replay rows statement with EXPLAIN ANALYZE: ${analyzed.seconds.toFixed(2)}s planning + execution (the page's cap is ${cap}s), ` +
            `${analyzed.rows} rows, shared blocks hit ${analyzed.hit}, read ${analyzed.read}:\n${analyzed.lines.join('\n')}`,
        );
        expect(analyzed.seconds, `the replayed rows statement of "${query}" (the page's cap is ${cap}s)`).toBeLessThan(cap);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!FULL_COUNT_CHECK)(
    'opt-in (PRODUCTS_FULL_COUNT_CHECK=1): the stored keyword counts agree with a fresh count on every catalog row',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        // Last of all, and only on request: the full pass, one probe of keyword_top_asins_asin_idx per catalog row (minutes on a cold
        // Neon, under the file's 300 s statement timeout), which warms the catalog and the pair table's index. Every row is checked,
        // the retired ones too: the build zeroes any row whose product left the pair table.
        await skipUnlessKeywordCounts(ctx);
        const started = performance.now();
        const mismatched = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT a.asin FROM asin_products a
             JOIN LATERAL (SELECT count(*)::int AS n FROM keyword_top_asins k WHERE k.asin = a.asin) c ON true
             WHERE a.keyword_count <> c.n LIMIT 1000
           ) m`,
        );
        console.log(
          `[productsQueries] stored keyword counts against a fresh count per catalog row: ${mismatched.rows[0].n} mismatched (stops at 1,000) ` +
            `in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
        expect(mismatched.rows[0].n, 'catalog rows whose stored keyword_count differs from a fresh count of keyword_top_asins').toBe(0);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
