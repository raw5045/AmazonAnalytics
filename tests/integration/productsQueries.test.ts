// tests/integration/productsQueries.test.ts
/**
 * The Products page's queries against the real database (migration 0051 applied):
 *  - the default landing view and the owner's example search are planned (EXPLAIN) and must be served
 *    by the 0051 partial indexes; the plans are printed as compact JSON for the record;
 *  - the owner's search runs for real through searchProducts (rows + capped count), timed;
 *  - the ASIN page's loaders (facts, snapshot history, keywords with weeks in top 3) answer for an ASIN
 *    taken from the search; an unknown ASIN has no facts.
 *
 * Read-only: every case runs inside BEGIN READ ONLY ... ROLLBACK on one dedicated connection (a stray
 * write would error), so nothing persists.
 *
 * Preconditions (owner-run only, never in CI):
 *  - migration 0051 applied (the six partial indexes built and valid);
 *  - the reverse-table backfill done for the keyword assertions: while keyword_top_asins_meta has no
 *    week they are skipped with a note ("reverse table not built yet");
 *  - no import running. A cold Neon can take tens of seconds for the first reads.
 *
 * Run (owner's go, Git Bash):
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PRODUCT_DEFAULTS, PRODUCT_PAGE_SIZE, type ProductFilters } from '@/lib/products/filters';
import { productSearchSql, searchProducts, type SqlRunner, type SqlStatement } from '@/lib/products/searchProducts';
import { loadProduct } from '@/lib/products/loadProduct';
import { loadProductHistory } from '@/lib/products/loadProductHistory';
import { loadProductKeywords, type ProductKeywordsResult } from '@/lib/products/loadProductKeywords';

const RUN = !!process.env.RUN_INTEGRATION;
const STATEMENT_TIMEOUT = '300s';
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

/** The owner's example search: listed within 180 days, 1,000+ sold a month, at most 300 reviews. */
const OWNER_SEARCH: ProductFilters = { ...PRODUCT_DEFAULTS, age: 180, soldMin: 1000, reviewsMax: 300 };

/** The parts of an EXPLAIN (FORMAT JSON) node these cases read. */
interface PlanNode {
  'Node Type': string;
  'Plan Rows': number;
  'Index Name'?: string;
  'Scan Direction'?: string;
  Plans?: PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

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
      await fn();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  /** EXPLAIN (FORMAT JSON) of a page statement with its real parameters (planned, not executed). */
  async function explain(q: SqlStatement): Promise<{ root: PlanNode; json: string; seconds: number }> {
    const started = performance.now();
    const res = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${q.text}`, q.values);
    const seconds = (performance.now() - started) / 1000;
    const raw = res.rows[0]['QUERY PLAN'];
    const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    return { root: plan[0].Plan, json: JSON.stringify(plan), seconds };
  }

  /** An ASIN for the loader cases: the first row of the owner's search, else of the default view. */
  async function sampleAsin(): Promise<{ asin: string; from: string }> {
    if (sample) return sample;
    for (const [from, filters] of [['the owner search', OWNER_SEARCH], ['the default view', PRODUCT_DEFAULTS]] as const) {
      const first = (await searchProducts(run, filters)).rows[0];
      if (first) return (sample = { asin: first.asin, from });
    }
    throw new Error('no product to sample: neither the owner search nor the default view returned a row');
  }

  it(
    'default landing view: the sold sort comes off asin_products_monthly_sold_idx',
    async () => {
      await inReadOnlyTransaction(async () => {
        const { root, json, seconds } = await explain(productSearchSql({ ...PRODUCT_DEFAULTS }).rows);
        const nodes = planNodes(root);
        const scan = nodes.find((n) => n['Index Name'] === 'asin_products_monthly_sold_idx');
        console.log(`[productsQueries] default view planned in ${seconds.toFixed(2)}s (${scan ? `${scan['Node Type']}, ${scan['Scan Direction'] ?? 'no direction'}` : 'index not used'}): ${json}`);

        expect(json, 'the plan of the default view').toContain('asin_products_monthly_sold_idx');
        // The top-N must come off the index. Any Sort left in the plan may only re-sort the one page the Limit hands it.
        const wideSorts = nodes.filter((n) => /Sort$/.test(n['Node Type']) && n['Plan Rows'] > PRODUCT_PAGE_SIZE);
        expect(wideSorts.map((n) => `${n['Node Type']} rows=${n['Plan Rows']}`), `Sort nodes over more than a page (${PRODUCT_PAGE_SIZE} rows)`).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the owner's search (age 180, sold >= 1,000, reviews <= 300) uses a 0051 index and returns a page",
    async () => {
      await inReadOnlyTransaction(async () => {
        const { json, seconds: planSeconds } = await explain(productSearchSql(OWNER_SEARCH).rows);
        const used = PRODUCT_SEARCH_INDEXES.filter((name) => json.includes(name));
        console.log(`[productsQueries] owner search planned in ${planSeconds.toFixed(2)}s (indexes: ${used.join(', ') || 'none'}): ${json}`);
        expect(used.length, 'a 0051 partial index in the plan of the owner search').toBeGreaterThanOrEqual(1);

        const started = performance.now();
        const result = await searchProducts(run, OWNER_SEARCH);
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
    'loadProduct answers null for an ASIN that neither the catalog nor the reverse table has',
    async () => {
      await inReadOnlyTransaction(async () => {
        expect(await loadProduct(run, 'ZZZZZZZZZZ')).toBeNull();
      });
    },
    TEST_TIMEOUT_MS,
  );
});
