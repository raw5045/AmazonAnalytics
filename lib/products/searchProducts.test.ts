// lib/products/searchProducts.test.ts
import { describe, it, expect } from 'vitest';
import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless';
import { asinProducts, keywordTopAsins } from '@/db/schema';
import { PRODUCT_DEFAULTS, PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE, PRODUCT_SORTS, type ProductFilters } from './filters';
import { productSearchSql, searchProducts, neonRunner, sortHidesNullKey, SORT_KEY_LABEL, PRODUCT_COUNT_CAP, PRODUCT_READ_TIMEOUT_MS } from './searchProducts';
import { aliasCols, dbCols } from './testHelpers';

type Sort = ProductFilters['sort'];
type Dir = ProductFilters['dir'];

/** The capped-count statement (the rows statement also contains `count(*)`, in its keyword-count lateral). */
const isCountStatement = (text: string) => text.startsWith('SELECT count(*)');
/** A statement's predicate text: from the base predicate up to the clause that follows it. */
const whereText = (text: string, next: string) => { const from = text.indexOf('a.in_scope'); return text.slice(from, text.indexOf(next, from)); };
/** Every sort but `keywords`, with the catalog column it orders by (and hides the nulls of). */
const NULLABLE_KEY_SORTS: Array<[sort: Sort, column: string]> = [
  ['sold', 'monthly_sold'], ['listed', 'listed_since'], ['reviews', 'review_count'], ['price', 'current_price_cents'], ['bsr', 'sales_rank'], ['ratio', 'rank_ratio_x100'],
];
const KEY_COLUMN = new Map<Sort, string>(NULLABLE_KEY_SORTS);
/** All 14 sort × direction pairs. */
const SORT_DIR_PAIRS: Array<[sort: Sort, dir: Dir]> = PRODUCT_SORTS.flatMap((sort): Array<[Sort, Dir]> => [[sort, 'asc'], [sort, 'desc']]);

/** The real neon driver's wire shapes, for the tests that run it against a replaced fetch. */
type Batch = { queries: Array<{ query: string; params: unknown[] }> };
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const okResults = (...results: unknown[]): FakeResponse => ({ ok: true, status: 200, json: async () => ({ results }) });
/** The result of a batch's leading SET LOCAL: no rows. */
const SET_RESULT = { command: 'SET', rowCount: null, rows: [], fields: [], rowAsArray: true };
/** What the neon HTTP endpoint answers when a statement fails: HTTP 400 and the error's fields as JSON. */
const sqlError = (code: string, message: string): FakeResponse => ({ ok: false, status: 400, json: async () => ({ message, code, severity: 'ERROR' }) });
/** Runs `fn` with a real neon client whose fetch is replaced by `respond`: nothing reaches a network or a database (the host cannot resolve either). */
async function withNeonFetch(respond: (url: string, batch: Batch) => FakeResponse, fn: (sql: NeonQueryFunction<false, false>) => Promise<void>): Promise<void> {
  const original = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (url: string, init: { body: string }) => respond(url, JSON.parse(init.body) as Batch);
  try {
    await fn(neon('postgresql://user:pw@db.invalid/app', { disableWarningInBrowsers: true }));
  } finally {
    neonConfig.fetchFunction = original;
  }
}

describe('productSearchSql', () => {
  it('applies the base predicate, hides null sort keys, and pages before counting keywords', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS);
    const t = q.rows.text;
    expect(t).toContain("a.in_scope AND a.enrichment_status IN ('active', 'no_price')");
    expect(t).toContain('a.monthly_sold IS NOT NULL');
    // The filter, the order and the page are the subquery (it carries the raw sort value as sort_key);
    // only its 50 rows get the keyword count, and the outer query restates the order.
    expect(t.startsWith('SELECT p.*, kc.keyword_count FROM (SELECT a.asin, ')).toBe(true);
    expect(t).toContain(', a.monthly_sold AS sort_key FROM asin_products a WHERE a.in_scope AND ');
    expect(t).toContain('ORDER BY a.monthly_sold DESC, a.asin DESC LIMIT $1 OFFSET $2) p LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = p.asin) kc ON true ORDER BY p.sort_key DESC, p.asin DESC');
    expect(t).not.toContain('NULLS');
    expect(t).not.toContain('COALESCE');
    expect(q.rows.values).toEqual([50, 0]);
    // The count carries the same WHERE (so the total is what the pager can reach) and stops at the cap.
    expect(q.count.text).toBe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL LIMIT ${PRODUCT_COUNT_CAP}) c`);
    expect(q.count.values).toEqual([]);
  });
  it('maps every filter to its predicate with bound values', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, cat: 'Tools › Bath', fba: 'no', amazon: 'yes', sort: 'listed', dir: 'asc', page: 3 });
    const t = q.rows.text;
    expect(t).toContain('a.listed_since >= current_date - $1::int');
    expect(t).toContain('a.monthly_sold >= $2::int');
    expect(t).toContain('a.review_count <= $3::int');
    expect(t).toContain('a.average_rating_x10 >= $4::int');
    expect(t).toContain('a.average_rating_x10 <= $5::int');
    expect(t).toContain('a.current_price_cents >= $6::int');
    expect(t).toContain('a.current_price_cents <= $7::int');
    expect(t).toContain('a.sales_rank >= $8::int');
    expect(t).toContain('a.sales_rank <= $9::int');
    expect(t).toContain('a.rank_ratio_x100 <= $10::int');
    expect(t).toContain("(a.category_path = $11::text OR starts_with(a.category_path, $12::text))");
    expect(t).toContain('a.fba_offer_count = 0');
    expect(t).toContain('a.amazon_availability >= 0');
    expect(t).toContain('a.listed_since IS NOT NULL');
    expect(t).toContain(', a.listed_since AS sort_key FROM asin_products a WHERE ');
    expect(t).toContain('ORDER BY a.listed_since ASC, a.asin ASC LIMIT $13 OFFSET $14) p');
    expect(t.endsWith(' ORDER BY p.sort_key ASC, p.asin ASC')).toBe(true);
    expect(q.rows.values).toEqual([90, 1000, 300, 40, 50, 999, 4000, 1, 50000, 70, 'Tools › Bath', 'Tools › Bath › ', 50, 100]);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
    expect(q.count.text).toContain('a.listed_since IS NOT NULL');
  });
  it('fba=yes and amazon=no', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, fba: 'yes', amazon: 'no' }).rows.text;
    expect(t).toContain('a.fba_offer_count > 0');
    expect(t).toContain('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  });
  it.each(SORT_DIR_PAIRS)('%s %s: the rows and count WHEREs match, and the tie-break follows the direction', (sort, dir) => {
    const D = dir.toUpperCase();
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 100, reviewsMax: 300, priceMaxCents: 5000, ratioMax: 80, cat: 'Tools › Bath', fba: 'yes', amazon: 'no', sort, dir, page: 2 });
    const rowsWhere = whereText(q.rows.text, ' ORDER BY ');
    const countWhere = whereText(q.count.text, ' LIMIT ');
    // The total counts exactly what the pager can reach: the same predicate, the same bound values.
    expect(rowsWhere.startsWith("a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND ")).toBe(true);
    expect(rowsWhere).toBe(countWhere);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
    expect(q.rows.values.slice(-2)).toEqual([50, 50]);
    expect(q.rows.text).not.toContain('NULLS');
    expect(q.rows.text).not.toContain('COALESCE');
    const key = KEY_COLUMN.get(sort);
    if (key === undefined) {
      // keywords: ordered by the count itself, so single-level; a count is never null, nothing is hidden.
      expect(q.rows.text).toContain(` ORDER BY kc.keyword_count ${D}, a.asin ${D} LIMIT $`);
      expect(q.rows.text.startsWith('SELECT a.asin, ')).toBe(true);
      expect(q.rows.text).not.toContain('sort_key');
      expect(rowsWhere).not.toContain('IS NOT NULL');
    } else {
      expect(rowsWhere.endsWith(` AND a.${key} IS NOT NULL`)).toBe(true);
      // The subquery selects the raw column as sort_key (not the ::text date or the CASE price) and orders by it.
      expect(q.rows.text).toContain(`, a.${key} AS sort_key FROM asin_products a WHERE `);
      expect(q.rows.text).toContain(` ORDER BY a.${key} ${D}, a.asin ${D} LIMIT $`);
      expect(q.rows.text.endsWith(` ORDER BY p.sort_key ${D}, p.asin ${D}`)).toBe(true);
    }
  });
  it('sorts by the keyword count single-level, through the lateral count', () => {
    const desc = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords' });
    const t = desc.rows.text;
    expect(t).toContain('LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = a.asin) kc ON true');
    expect(t).toContain('ORDER BY kc.keyword_count DESC, a.asin DESC LIMIT $1 OFFSET $2');
    expect(t).toContain('kc.keyword_count FROM asin_products a LEFT JOIN LATERAL');
    expect(t).not.toContain(') p ');
    expect(t).not.toContain('IS NOT NULL');
    expect(desc.count.text).not.toContain('IS NOT NULL');
    expect(productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords', dir: 'asc' }).rows.text).toContain('ORDER BY kc.keyword_count ASC, a.asin ASC LIMIT $1 OFFSET $2');
  });
  it.each(PRODUCT_SORTS)('%s: names only real columns', (sort) => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, sort, age: 60, cat: 'x', fba: 'yes', amazon: 'yes', ratioMax: 50 }).rows.text;
    const a = aliasCols(t, 'a');
    expect([...a].filter((c) => !dbCols(asinProducts).has(c))).toEqual([]);
    expect([...aliasCols(t, 'k')].filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
    // `p` is the page subquery: every column the outer query reads from it is one the subquery selects from `a`
    // (sort_key is an alias of the sort's own column).
    const key = KEY_COLUMN.get(sort);
    const fromP = [...aliasCols(t, 'p')].map((c) => (c === 'sort_key' ? key ?? c : c));
    expect(fromP.filter((c) => !a.has(c))).toEqual([]);
    expect(aliasCols(t, 'p').has('sort_key')).toBe(key !== undefined);
  });
});

describe('sortHidesNullKey', () => {
  it('is true for every sort but keywords', () => {
    expect(Object.fromEntries(PRODUCT_SORTS.map((s) => [s, sortHidesNullKey(s)]))).toEqual({ sold: true, listed: true, reviews: true, price: true, bsr: true, ratio: true, keywords: false });
  });
  it('is paired with a human field name for each sort that hides rows', () => {
    expect(SORT_KEY_LABEL).toEqual({ sold: 'monthly sold badge', listed: 'listing date', reviews: 'review count', price: 'price', bsr: 'BSR', ratio: 'BSR ratio' });
    expect(Object.keys(SORT_KEY_LABEL).sort()).toEqual(PRODUCT_SORTS.filter(sortHidesNullKey).sort());
  });
  it('narrows the sort so the page can look the label up', () => {
    const hint = (sort: Sort) => (sortHidesNullKey(sort) ? `Products without a ${SORT_KEY_LABEL[sort]} are hidden under this sort.` : null);
    expect(hint('sold')).toBe('Products without a monthly sold badge are hidden under this sort.');
    expect(hint('keywords')).toBeNull();
  });
});

describe('searchProducts', () => {
  it('runs both statements and maps rows', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fake = async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return isCountStatement(text)
        ? [{ n: 3 }]
        : [{ asin: 'B000000001', title: 'Lamp', brand: 'Acme', listed_since: '2026-08-01', monthly_sold: 1000, review_count: 120, average_rating_x10: 44, current_price_cents: 1999, sales_rank: 1234, rank_ratio_x100: 65, fba_offer_count: 3, fbm_offer_count: 1, amazon_availability: -1, enrichment_status: 'active', keyword_count: 7, sort_key: 1000 }];
    };
    const r = await searchProducts(fake, PRODUCT_DEFAULTS);
    expect(r.total).toBe(3);
    expect(r.totalIsCapped).toBe(false);
    expect(r).not.toHaveProperty('countTimedOut');
    expect(r.rows[0]).toMatchObject({ asin: 'B000000001', monthlySold: 1000, rankRatioX100: 65, keywordCount: 7, amazonAvailability: -1 });
    // sort_key only carries the outer re-sort; it is not part of the mapped row.
    expect(r.rows[0]).not.toHaveProperty('sort_key');
    expect(r.rows[0]).not.toHaveProperty('sortKey');
    expect(calls).toHaveLength(2);
  });
  it('flags a capped total and defaults a missing keyword count to 0', async () => {
    const fake = async (text: string) => (isCountStatement(text) ? [{ n: PRODUCT_COUNT_CAP }] : [{ asin: 'B000000002', keyword_count: null }]);
    const r = await searchProducts(fake, { ...PRODUCT_DEFAULTS, page: 2 });
    // The cap is the pager's last reachable row (the "10,000+" copy).
    expect(PRODUCT_COUNT_CAP).toBe(PRODUCT_MAX_PAGE * PRODUCT_PAGE_SIZE);
    expect(PRODUCT_COUNT_CAP).toBe(10_000);
    expect(r.total).toBe(PRODUCT_COUNT_CAP);
    expect(r.totalIsCapped).toBe(true);
    expect(r.rows[0].keywordCount).toBe(0);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(50);
  });

  describe('the count is best-effort under the statement timeout', () => {
    const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

    it('turns a count that hits the statement timeout (57014) into a capped total and keeps the rows', async () => {
      const events: string[] = [];
      const fake = async (text: string) => {
        if (isCountStatement(text)) {
          events.push('count:start');
          throw timeout();
        }
        events.push('rows:start');
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.push('rows:end');
        return [{ asin: 'B000000003', keyword_count: 2 }];
      };
      const r = await searchProducts(fake, PRODUCT_DEFAULTS);
      expect(r).toMatchObject({ total: PRODUCT_COUNT_CAP, totalIsCapped: true, countTimedOut: true, page: 1, pageSize: PRODUCT_PAGE_SIZE });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ asin: 'B000000003', keywordCount: 2 });
      // Rows and count run in parallel: the count starts before the rows finish.
      expect(events).toEqual(['rows:start', 'count:start', 'rows:end']);
    });
    it('rejects when the count fails for any other reason', async () => {
      for (const error of [Object.assign(new Error('too many connections'), { code: '53300' }), new Error('Error connecting to database')]) {
        const fake = async (text: string) => {
          if (isCountStatement(text)) throw error;
          return [];
        };
        await expect(searchProducts(fake, PRODUCT_DEFAULTS)).rejects.toBe(error);
      }
    });
    it('rejects when the rows statement times out: only the count is best-effort', async () => {
      const error = timeout();
      const fake = async (text: string) => {
        if (!isCountStatement(text)) throw error;
        return [{ n: 3 }];
      };
      await expect(searchProducts(fake, PRODUCT_DEFAULTS)).rejects.toBe(error);
    });
    it('with the real neon driver: a 57014 on the count is a capped total, any other server error still rejects', async () => {
      const rowsResult = { command: 'SELECT', rowCount: 1, rows: [['B000000001']], fields: [{ name: 'asin', dataTypeID: 25 }], rowAsArray: true };
      // Each statement is its own batch (SET LOCAL, then the statement): fail the count's, answer the rows'.
      const serve = (onCount: FakeResponse) => (_url: string, batch: Batch) => (batch.queries[1].query.startsWith('SELECT count(*)') ? onCount : okResults(SET_RESULT, rowsResult));
      await withNeonFetch(serve(sqlError('57014', 'canceling statement due to statement timeout')), async (sql) => {
        const r = await searchProducts(neonRunner(sql), PRODUCT_DEFAULTS);
        expect(r).toMatchObject({ total: PRODUCT_COUNT_CAP, totalIsCapped: true, countTimedOut: true });
        expect(r.rows.map((row) => row.asin)).toEqual(['B000000001']);
      });
      await withNeonFetch(serve(sqlError('53200', 'out of memory')), async (sql) => {
        await expect(searchProducts(neonRunner(sql), PRODUCT_DEFAULTS)).rejects.toMatchObject({ name: 'NeonDbError', code: '53200' });
      });
    });
  });
});

describe('neonRunner', () => {
  type Recorded = { text: string; values?: unknown[] };
  /** A neon stand-in: `query` returns a lazy handle (here just the statement); `transaction` records the batch it is given. */
  const fakeNeon = (respond: (statements: Recorded[]) => unknown[]) => {
    const transactions: Recorded[][] = [];
    const sql = {
      query: (text: string, values?: unknown[]): Recorded => ({ text, values }),
      transaction: async (statements: Recorded[]) => { transactions.push(statements); return respond(statements); },
    };
    return { sql: sql as never, transactions };
  };

  it('runs each statement in one transaction behind SET LOCAL statement_timeout and returns the last result set', async () => {
    const { sql, transactions } = fakeNeon(() => [[], [{ n: 1 }]]);
    await expect(neonRunner(sql)('SELECT $1::int AS n', [1])).resolves.toEqual([{ n: 1 }]);
    expect(PRODUCT_READ_TIMEOUT_MS).toBe(30_000);
    expect(transactions).toEqual([[{ text: 'SET LOCAL statement_timeout = 30000' }, { text: 'SELECT $1::int AS n', values: [1] }]]);
  });
  it("caps both of a search's statements, each in its own transaction", async () => {
    const { sql, transactions } = fakeNeon((statements) => [[], isCountStatement(statements[1].text) ? [{ n: 3 }] : [{ asin: 'B000000001', keyword_count: 7 }]]);
    const r = await searchProducts(neonRunner(sql), PRODUCT_DEFAULTS);
    expect(r.total).toBe(3);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ asin: 'B000000001', keywordCount: 7 });
    expect(transactions).toHaveLength(2);
    for (const statements of transactions) {
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toBe(`SET LOCAL statement_timeout = ${PRODUCT_READ_TIMEOUT_MS}`);
    }
  });
  it('lets a timeout (a rejected transaction) reach the caller', async () => {
    const { sql } = fakeNeon(() => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); });
    await expect(neonRunner(sql)('SELECT 1', [])).rejects.toMatchObject({ code: '57014' });
  });
  it('works with the real neon client: one batched request carries SET LOCAL then the query, and the rows come back last', async () => {
    const requests: Array<{ url: string; batch: Batch }> = [];
    await withNeonFetch(
      (url, batch) => {
        requests.push({ url, batch });
        return okResults(SET_RESULT, { command: 'SELECT', rowCount: 1, rows: [['1']], fields: [{ name: 'n', dataTypeID: 23 }], rowAsArray: true });
      },
      async (sql) => {
        await expect(neonRunner(sql)('SELECT $1::int AS n', [1])).resolves.toEqual([{ n: 1 }]);
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/^https:\/\/[^/]+\.invalid\/sql$/);
    expect(requests[0].batch.queries).toEqual([
      { query: `SET LOCAL statement_timeout = ${PRODUCT_READ_TIMEOUT_MS}`, params: [] },
      { query: 'SELECT $1::int AS n', params: ['1'] },
    ]);
  });
});
