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
 *  - the broad-category filter (spec 2026-10-12 broad category), six cases, the cold ones first (the
 *    picks of the smallest code and of the low-share code read the whole broad index and the pair-table
 *    heap, and would warm what a later timed read touches; the largest code and the heaviest ASIN come
 *    from pg_stats for the same reason, the aggregate only when the statistics have no value). Every
 *    broad search has its rows statement and its count statement planned (both plans are printed) and
 *    runs through searchProducts under the default sort, the two statements TIMED APART and each held
 *    to the page's cap (PRODUCT_READ_TIMEOUT_MS; the page runs them in parallel with a cap each, here
 *    they run back to back on one connection, under a local 60 s statement timeout so a bad plan
 *    cannot outlive the case). The rows statement is then re-run with EXPLAIN (ANALYZE, BUFFERS): its
 *    loop counts tell a probe of the broad index per candidate from one read of the code's ASINs,
 *    which a plain plan outline cannot. Every row is checked to have a pair row carrying the code. In
 *    order: the largest code must plan on keyword_top_asins_broad_category_idx; the code list
 *    statement (the loader's own text, BROAD_CATEGORY_LIST_SQL, imported; the loader itself is not
 *    called) lists every distinct code inside a 5 s cold bound (a loose index scan: well under a
 *    second warm); the codes read of the heaviest ASIN (now on the ASIN page's first-paint path) is
 *    timed with EXPLAIN (ANALYZE, BUFFERS) against the cap, under the same local cap; the smallest
 *    code by distinct products (the spec measured single-ASIN codes) must also start from the code's
 *    ASINs, not walk the sold sort index; the code with the lowest share of in-scope products among
 *    its pair rows (at least 5,000 of them: the planner's worst case, which estimates the semi-join as
 *    if every pair-table ASIN had a catalog product) must stay inside the cap, its search warm because
 *    the pick read the same pages; and loadProduct lists a multi-code ASIN's codes, most keywords
 *    first, checked against a per-code count;
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
 *  - migration 0052 applied (checked up front: the file fails at once when keyword_top_asins has no
 *    broad_category column) and that column filled (the one-off same-week rebuild, spec 2026-10-12
 *    broad category §4): until keyword_top_asins has a coded row the six broad cases skip with a note
 *    ("broad_category not filled");
 *  - a custom category with stored paths (any account's; only its paths are read) for the two
 *    custom-category cases: when there is none they are skipped ("no custom category to test with");
 *  - no import running. A cold Neon can take tens of seconds for the first reads.
 *
 * Run (owner's go, Git Bash), the products file first and alone (its timings must be cold: the build
 * test's carry sorts the whole live pair table and would warm it), then the build test:
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts --disableConsoleIntercept
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts --disableConsoleIntercept
 */
import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { EMPTY_CATEGORY_SCOPE, pageCategoryScope } from '@/lib/products/categoryPredicate';
import { PRODUCT_DEFAULTS, PRODUCT_PAGE_SIZE, type ProductFilters } from '@/lib/products/filters';
import { PRODUCT_READ_TIMEOUT_MS, productSearchSql, searchProducts, type ProductSearchResult, type ProductSummaryRow, type SqlRunner, type SqlStatement } from '@/lib/products/searchProducts';
import { BROAD_CATEGORY_LIST_SQL } from '@/lib/products/listCategories';
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
/**
 * The local cap on a timed broad read (a search, or the heaviest ASIN's codes): twice the page's own (the page stops a read at
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
/** The category filter's index (migration 0050): category_path text_pattern_ops, partial on in_scope AND category_path IS NOT NULL. */
const CATEGORY_PATH_INDEX = 'asin_products_category_path_idx';
/** The broad-category filter's index (migration 0052): (broad_category, asin) over the coded rows of keyword_top_asins. */
const BROAD_INDEX = 'keyword_top_asins_broad_category_idx';

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
    const column = await client.query<{ ok: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'keyword_top_asins' AND column_name = 'broad_category') AS ok",
    );
    if (!column.rows[0]?.ok) throw new Error('migration 0052 is not applied (keyword_top_asins has no broad_category column)');
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

  /** The column is filled by the one-off same-week rebuild (spec 2026-10-12 broad category §4); before it, the broad cases skip. */
  async function codesPresent(): Promise<boolean> {
    const r = await client.query('SELECT 1 FROM keyword_top_asins WHERE broad_category IS NOT NULL LIMIT 1');
    return (r.rowCount ?? 0) > 0;
  }

  /** The start of every broad case: skip it, with a note, until the column is filled (ctx.skip throws, so nothing after it runs). */
  async function skipUnlessCodes(ctx: TestContext): Promise<void> {
    if (await codesPresent()) return;
    console.log('[productsQueries] broad_category not filled yet: skipped');
    ctx.skip('broad_category not filled');
  }

  /**
   * The first most-common value of a keyword_top_asins column per the planner's statistics (pg_stats): the largest code, or one of the
   * heaviest ASINs, read without a scan of the table, so the read timed next is not warmed by a full scan. Null when the statistics have
   * no such value (not analyzed since the column was filled, no value repeats in the sample, or the table is not in the current
   * schema); the callers then count instead.
   */
  async function mostCommon(column: 'broad_category' | 'asin'): Promise<string | null> {
    const r = await client.query<{ v: string | null }>(
      "SELECT (most_common_vals::text::text[])[1] AS v FROM pg_stats WHERE schemaname = current_schema() AND tablename = 'keyword_top_asins' AND attname = $1",
      [column],
    );
    return r.rows[0]?.v ?? null;
  }

  /** The code with the most pair rows: from the statistics, else (no statistics row yet) by counting every code. */
  async function largestCode(): Promise<string> {
    const common = await mostCommon('broad_category');
    if (common !== null) return common;
    const counted = await client.query<{ broad_category: string }>(
      'SELECT broad_category FROM keyword_top_asins WHERE broad_category IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1',
    );
    return counted.rows[0].broad_category;
  }

  /**
   * EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of a page statement. Unlike explain() it RUNS the statement (a read, so fine in this
   * transaction) and reports the server's own planning plus execution time (the clock the page's statement cap runs on), the rows
   * the top node produced, and the blocks it hit in and read into the shared buffers (reads = misses in shared buffers; Neon's local
   * file cache may still serve them). The outline carries each node's actual rows and loops.
   */
  async function explainAnalyze(q: SqlStatement): Promise<{ lines: string[]; rows: number; seconds: number; hit: number; read: number }> {
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
   * One broad-category search under the default sort (spec 2026-10-12 broad category §5); `note` says how warm it runs, when that is
   * known. Both statements are planned (EXPLAIN, so the plans print even if the count later aborts the transaction). The search runs
   * for real through searchProducts under a local SEARCH_TIMEOUT, with its rows statement and its count statement timed apart (they run
   * back to back on this one connection, while the page runs them in parallel with a cap each) and each held to the page's cap. The
   * rows statement is then re-run with EXPLAIN (ANALYZE, BUFFERS), whose loop counts tell a probe of the broad index per candidate (a
   * nested-loop walk of the sort index) from one read of the code's ASINs (the ASIN-set-first plan), which a plain plan outline cannot;
   * the local cap stays on through that re-run, so a bad plan cannot outlive the case there either. Last, every row of the page is
   * checked to have a pair row carrying the code, whatever plan served it.
   */
  async function broadSearch(code: string, note?: string): Promise<{ lines: string[]; rows: ProductSummaryRow[] }> {
    const cap = PRODUCT_READ_TIMEOUT_MS / 1000;
    const filters: ProductFilters = { ...PRODUCT_DEFAULTS, broadCategory: code };
    const q = productSearchSql(filters, EMPTY_CATEGORY_SCOPE);
    const planned = await explain(q.rows);
    console.log(`[productsQueries] broad category "${code}" rows plan (planned in ${planned.seconds.toFixed(2)}s):\n${planned.lines.join('\n')}`);
    const countPlanned = await explain(q.count);
    console.log(`[productsQueries] broad category "${code}" count plan (planned in ${countPlanned.seconds.toFixed(2)}s):\n${countPlanned.lines.join('\n')}`);

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
      result = await searchProducts(timedRun, filters, EMPTY_CATEGORY_SCOPE);
    } catch (e) {
      // searchProducts swallows a count cancelled by the cap, so a statement timeout (SQLSTATE 57014, query_canceled) that gets out is
      // the rows statement's; any other error is left as it is.
      if ((e as { code?: unknown } | null)?.code !== '57014') throw e;
      throw new Error(`the rows statement of "${code}" hit the local ${SEARCH_TIMEOUT} cap (the page's is ${cap}s) after ${((performance.now() - started) / 1000).toFixed(1)}s`, { cause: e });
    }
    const seconds = { rows: 0, count: 0 };
    let previous = started;
    for (const done of finished) {
      seconds[done.statement] = (done.at - previous) / 1000;
      previous = done.at;
    }
    console.log(
      `[productsQueries] broad category "${code}" search${note ? `, ${note}` : ''}: rows statement ${seconds.rows.toFixed(2)}s, count statement ${seconds.count.toFixed(2)}s ` +
        `(the page's cap is ${cap}s each), countTimedOut ${result.countTimedOut === true}; ${result.rows.length} rows on page ${result.page}, ${result.total}${result.totalIsCapped ? '+' : ''} matches`,
    );
    const over = (['rows', 'count'] as const).filter((statement) => seconds[statement] >= cap);
    if (over.length > 0) console.log(`[productsQueries] OVER THE PAGE'S ${cap}s CAP: the ${over.join(' and the ')} statement of the "${code}" search`);
    // searchProducts swallows a count cancelled by the local cap, but the cancelled statement aborted this transaction: nothing more can run in it.
    if (result.countTimedOut) {
      throw new Error(`the count statement of the "${code}" search hit the local ${SEARCH_TIMEOUT} cap (the page's is ${cap}s) and aborted the transaction; its rows statement took ${seconds.rows.toFixed(1)}s`);
    }

    // The rows statement again (warm now): what each node really did, and how many times.
    const analyzed = await explainAnalyze(q.rows);
    console.log(
      `[productsQueries] broad category "${code}" rows statement re-run with EXPLAIN ANALYZE (warm): ${analyzed.seconds.toFixed(2)}s planning + execution, ${analyzed.rows} rows, ` +
        `shared blocks hit ${analyzed.hit}, read ${analyzed.read}:\n${analyzed.lines.join('\n')}`,
    );
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const without = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM unnest($1::text[]) a(asin) WHERE NOT EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin AND k.broad_category = $2)',
      [result.rows.map((r) => r.asin), code],
    );
    expect(without.rows[0].n, `rows of the "${code}" page with no pair row carrying the code`).toBe(0);
    expect(seconds.rows, `rows statement of the "${code}" search (the page's cap is ${cap}s)`).toBeLessThan(cap);
    expect(seconds.count, `count statement of the "${code}" search (the page's cap is ${cap}s)`).toBeLessThan(cap);
    return { lines: planned.lines, rows: result.rows };
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
    'the largest broad category under the default sort plans on the broad index and every row carries the code',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const code = await largestCode();
        const { lines, rows } = await broadSearch(code);
        // Counted only after the timed read, so the scan of the code's index entries did not warm it.
        const size = await client.query<{ pairs: number; asins: number }>(
          'SELECT count(*)::int AS pairs, count(DISTINCT asin)::int AS asins FROM keyword_top_asins WHERE broad_category = $1',
          [code],
        );
        console.log(`[productsQueries] largest code "${code}": ${size.rows[0].pairs} pair rows, ${size.rows[0].asins} distinct ASINs`);
        expect(lines.join('\n'), `the plan of the "${code}" search`).toContain(BROAD_INDEX);
        expect(rows.length, `rows on the "${code}" page`).toBeGreaterThanOrEqual(1);
        expect(rows.length, `rows on the "${code}" page`).toBeLessThanOrEqual(PRODUCT_PAGE_SIZE);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the code list statement runs inside the 5 s cold bound and lists every distinct code',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The page's own statement (lib/products/listCategories.ts): a loose index scan, one probe of the broad index per code. Well under a
        // second warm; 5 s is the cold bound.
        const started = performance.now();
        const listed = await client.query<{ code: string }>(BROAD_CATEGORY_LIST_SQL);
        const seconds = (performance.now() - started) / 1000;
        console.log(`[productsQueries] broad category list: ${listed.rows.length} codes in ${seconds.toFixed(2)}s (the cold bound is 5s)`);
        // The slow way, once: a distinct count over every coded row.
        const distinct = await client.query<{ n: number }>('SELECT count(DISTINCT broad_category)::int AS n FROM keyword_top_asins WHERE broad_category IS NOT NULL');
        expect(listed.rows.length, 'codes the list statement returns, against the distinct codes on the table').toBe(distinct.rows[0].n);
        expect(seconds, 'the code list statement (the cold bound)').toBeLessThan(5);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the smallest broad category by distinct products starts from the code's ASINs, not from the sort index",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The code with the fewest distinct ASINs (the spec measured single-ASIN codes such as Alexa and Digital_Periodicals). A plan that
        // walks the sold sort index would probe the broad index once per candidate product, which for a code like this is the whole sort index.
        const picked = await client.query<{ broad_category: string; asins: number; pairs: number }>(
          'SELECT broad_category, count(DISTINCT asin)::int AS asins, count(*)::int AS pairs FROM keyword_top_asins WHERE broad_category IS NOT NULL GROUP BY 1 ORDER BY count(DISTINCT asin), count(*), 1 LIMIT 1',
        );
        const { broad_category: code, asins, pairs } = picked.rows[0];
        console.log(`[productsQueries] smallest code by distinct products: "${code}", ${asins} ASINs in ${pairs} pair rows`);
        const { lines, rows } = await broadSearch(code);
        const plan = lines.join('\n');
        expect(plan, `the plan of the "${code}" search`).toContain(BROAD_INDEX);
        expect(plan, `the plan of the "${code}" search must not walk the sold sort index`).not.toContain('asin_products_monthly_sold_idx');
        expect(rows.length, `rows on the page of "${code}" (${asins} ASINs)`).toBeLessThanOrEqual(asins);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a code with many pair rows but few in-scope products stays under the page's cap",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The worst case for the planner, which estimates the semi-join as if every pair-table ASIN had a catalog product: of the codes with
        // at least 5,000 pair rows, the one whose pair rows reach the smallest share of products the page can show (in scope, active or
        // no_price, with the monthly sold badge), the larger code on a tie. It joins the pair table to the catalog: tens of seconds cold, so
        // the hash gets its memory, taken away again before the search so that runs under the page's own conditions.
        await client.query("SET LOCAL work_mem = '256MB'");
        const picked = await client.query<{ broad_category: string; pairs: number; in_scope_share: number }>(
          `SELECT k.broad_category, count(*)::int AS pairs, count(a.asin)::float / count(*) AS in_scope_share
           FROM keyword_top_asins k
           LEFT JOIN asin_products a ON a.asin = k.asin AND a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL
           WHERE k.broad_category IS NOT NULL
           GROUP BY 1 HAVING count(*) >= 5000
           ORDER BY count(a.asin)::float / count(*) ASC, count(*) DESC LIMIT 1`,
        );
        await client.query('SET LOCAL work_mem TO DEFAULT');
        const worst = picked.rows[0];
        if (!worst) {
          console.log('[productsQueries] no broad category has 5,000 pair rows: the low-share case is skipped.');
          return ctx.skip('no broad category with 5,000 pair rows');
        }
        console.log(`[productsQueries] lowest in-scope share: "${worst.broad_category}", ${worst.pairs} pair rows, ${(worst.in_scope_share * 100).toFixed(1)}% of them on products the page can show`);
        // The pick has just read the same pages the search reads, so the times printed are warm ones: a cold first visit can be slower.
        const { rows } = await broadSearch(worst.broad_category, 'warm (the pick read the same pages)');
        // An empty page is a valid answer here: this case asserts the times (inside broadSearch), the cases above the plan shapes.
        console.log(`[productsQueries] "${worst.broad_category}": the page holds ${rows.length} rows`);
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
