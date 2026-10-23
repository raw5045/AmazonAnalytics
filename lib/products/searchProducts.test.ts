// lib/products/searchProducts.test.ts
import { describe, it, expect } from 'vitest';
import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless';
import { asinProducts, baCategoryCrosswalk } from '@/db/schema';
import { EMPTY_CATEGORY_SCOPE, type ProductCategoryScope } from './categoryPredicate';
import { PRODUCT_DEFAULTS, PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE, PRODUCT_SORTS, type ProductFilters } from './filters';
import { productSearchSql, searchProducts, neonRunner, sortHidesNullKey, SORT_KEY_LABEL, PRODUCT_COUNT_CAP, PRODUCT_READ_TIMEOUT_MS } from './searchProducts';
import { aliasCols, dbCols, notIn, recordingRow, selectNames } from './testHelpers';

type Sort = ProductFilters['sort'];
type Dir = ProductFilters['dir'];

/** The capped-count statement: the only one that starts with `SELECT count(*)` (the rows statement starts with `SELECT a.asin`). */
const isCountStatement = (text: string) => text.startsWith('SELECT count(*)');
/** A statement's predicate text: from the base predicate up to the clause that follows it. */
const whereText = (text: string, next: string) => { const from = text.indexOf('a.in_scope'); return text.slice(from, text.indexOf(next, from)); };
/** Every sort but `keywords`, with the catalog column it orders by (and hides the nulls of). */
const NULLABLE_KEY_SORTS: Array<[sort: Sort, column: string]> = [
  ['sold', 'monthly_sold'], ['listed', 'listed_since'], ['reviews', 'review_count'], ['price', 'current_price_cents'], ['bsr', 'sales_rank'], ['ratio', 'rank_ratio_x100'],
];
const KEY_COLUMN = new Map<Sort, string>(NULLABLE_KEY_SORTS);
/** The column every sort orders by: the six nullable ones above, and the stored keyword count (NOT NULL, so it hides nothing; spec 2026-10-23 §5). */
const ORDER_COLUMN = new Map<Sort, string>([...NULLABLE_KEY_SORTS, ['keywords', 'keyword_count']]);
/** The end of the page columns: the stored keyword count (the Keywords column) sits with the integer facts, and the catalog follows. */
const COLUMNS_TAIL = 'a.amazon_availability, a.keyword_count, a.enrichment_status::text AS enrichment_status FROM asin_products a WHERE ';
/** A raw rows-statement row with every column the page selects. */
const RAW_ROW = {
  asin: 'B000000001', title: 'Lamp', brand: 'Acme', category_path: 'Home & Kitchen › Lighting › Desk Lamps', listed_since: '2026-08-01', monthly_sold: 1000, review_count: 120, average_rating_x10: 44,
  current_price_cents: 1999, sales_rank: 1234, rank_ratio_x100: 65, fba_offer_count: 3, fbm_offer_count: 1, amazon_availability: -1, keyword_count: 7, enrichment_status: 'active',
};
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
  it('applies the base predicate, hides null sort keys, and orders the page in one level over the catalog', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE);
    const t = q.rows.text;
    expect(t).toContain("a.in_scope AND a.enrichment_status IN ('active', 'no_price')");
    expect(t).toContain('a.monthly_sold IS NOT NULL');
    // One level: the page columns (the stored keyword count among them), the filter, the order and the page. Nothing is joined
    // to the page, so the order is the order of the sort's (key, asin) index.
    expect(t.startsWith('SELECT a.asin, ')).toBe(true);
    expect(t).toContain(COLUMNS_TAIL);
    expect(t.endsWith(" FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL ORDER BY a.monthly_sold DESC, a.asin DESC LIMIT $1 OFFSET $2")).toBe(true);
    expect(t).not.toContain('LATERAL');
    expect(t).not.toContain('keyword_top_asins');
    expect(t).not.toContain('sort_key');
    expect(t).not.toContain('NULLS');
    expect(t).not.toContain('COALESCE');
    expect(q.rows.values).toEqual([50, 0]);
    // The count carries the same WHERE (so the total is what the pager can reach) and stops at the cap.
    expect(q.count.text).toBe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL LIMIT ${PRODUCT_COUNT_CAP}) c`);
    expect(q.count.values).toEqual([]);
  });
  it('maps every filter to its predicate with bound values; the category scope sits between ratioMax and the offer filters', () => {
    const scope: ProductCategoryScope = { dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: ['Tools › Bath › Mats'], scoped: true };
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, fba: 'no', amazon: 'yes', sort: 'listed', dir: 'asc', page: 3 }, scope);
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
    expect(t).toContain('(a.category_path = $11::text OR starts_with(a.category_path, $12::text)) AND ((a.category_path = $13::text OR starts_with(a.category_path, $14::text)) OR a.category_path = ANY($15::text[])) AND a.fba_offer_count = 0');
    expect(t).toContain('a.amazon_availability >= 0');
    expect(t).toContain('a.listed_since IS NOT NULL');
    expect(t.endsWith(' AND a.listed_since IS NOT NULL ORDER BY a.listed_since ASC, a.asin ASC LIMIT $16 OFFSET $17')).toBe(true);
    expect(q.rows.values).toEqual([90, 1000, 300, 40, 50, 999, 4000, 1, 50000, 70, 'Tools', 'Tools › ', 'Tools › Bath', 'Tools › Bath › ', ['Tools › Bath › Mats'], 50, 100]);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
    expect(q.count.text).toContain('a.listed_since IS NOT NULL');
  });
  it('the category fields of the filters object are not read: the scope alone decides', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, dept: 'Tools', leafPaths: ['Tools › Bath'], customCategoryIds: ['11111111-1111-4111-8111-000000000001'] }, EMPTY_CATEGORY_SCOPE);
    expect(q.rows.text).not.toContain('category_path =');
    expect(q.rows.values).toEqual([50, 0]);
  });
  it("broadCategory is a semi-join on the crosswalk: the product's path must be one of the code's paths (spec 2026-10-14 §6)", () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' }, EMPTY_CATEGORY_SCOPE);
    expect(q.rows.text).toContain('a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = $1::text) AND a.monthly_sold IS NOT NULL');
    expect(q.rows.values).toEqual(['Home', 50, 0]);
    expect(q.count.text).toContain('x.code = $1::text');
    expect(q.count.values).toEqual(['Home']);
    expect(aliasCols(q.rows.text, 'x')).toEqual(new Set(['category_path', 'code']));
    expect(notIn(aliasCols(q.rows.text, 'x'), dbCols(baCategoryCrosswalk))).toEqual([]);
  });
  it('the broad category predicate follows the category scope and precedes the offer filters', () => {
    const scope: ProductCategoryScope = { dept: 'Tools', subtreePaths: [], exactPaths: [], scoped: false };
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, dept: 'Tools', broadCategory: 'Home', fba: 'no' }, scope);
    expect(q.rows.text).toContain(
      '(a.category_path = $1::text OR starts_with(a.category_path, $2::text)) AND a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = $3::text) AND a.fba_offer_count = 0',
    );
    expect(q.rows.values).toEqual(['Tools', 'Tools › ', 'Home', 50, 0]);
  });
  it('no predicate and no bind for a null broad category', () => {
    expect(productSearchSql(PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE).rows.text).not.toContain('ba_category_crosswalk');
    expect(productSearchSql(PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE).rows.values).toEqual([50, 0]);
  });
  it('a scoped selection with no paths matches nothing, in the rows and the count', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS, { ...EMPTY_CATEGORY_SCOPE, scoped: true });
    expect(q.rows.text).toContain(' AND FALSE AND a.monthly_sold IS NOT NULL');
    expect(q.count.text).toContain(' AND FALSE AND a.monthly_sold IS NOT NULL');
  });
  it('selects the category path for the Category column', () => {
    expect(productSearchSql(PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE).rows.text).toContain('a.brand, a.category_path, a.listed_since::text AS listed_since');
  });
  it('fba=yes and amazon=no', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, fba: 'yes', amazon: 'no' }, EMPTY_CATEGORY_SCOPE).rows.text;
    expect(t).toContain('a.fba_offer_count > 0');
    expect(t).toContain('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  });
  it.each(SORT_DIR_PAIRS)('%s %s: the rows and count WHEREs match, and one level orders by the sort column with the tie-break in its direction', (sort, dir) => {
    const D = dir.toUpperCase();
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 100, reviewsMax: 300, priceMaxCents: 5000, ratioMax: 80, broadCategory: 'Home', fba: 'yes', amazon: 'no', sort, dir, page: 2 }, { ...EMPTY_CATEGORY_SCOPE, dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: ['Tools › Bath › Mats'], scoped: true });
    const rowsWhere = whereText(q.rows.text, ' ORDER BY ');
    const countWhere = whereText(q.count.text, ' LIMIT ');
    // The total counts exactly what the pager can reach: the same predicate, the same bound values.
    expect(rowsWhere.startsWith("a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND ")).toBe(true);
    expect(rowsWhere).toBe(countWhere);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
    expect(q.rows.values.slice(-2)).toEqual([50, 50]);
    expect(q.rows.text).not.toContain('NULLS');
    expect(q.rows.text).not.toContain('COALESCE');
    // Every sort is one level over the catalog: the page columns (the stored keyword count among them), the WHERE, then the order by
    // the raw column (not the ::text date or the CASE price) and the page, with nothing after it: no page subquery, no re-sort.
    const n = q.rows.values.length;
    expect(q.rows.text.startsWith('SELECT a.asin, ')).toBe(true);
    expect(q.rows.text).toContain(COLUMNS_TAIL);
    expect(q.rows.text.endsWith(`${rowsWhere} ORDER BY a.${ORDER_COLUMN.get(sort)} ${D}, a.asin ${D} LIMIT $${n - 1} OFFSET $${n}`)).toBe(true);
    for (const gone of ['LATERAL', 'kc.', 'keyword_top_asins', 'sort_key']) expect(q.rows.text, gone).not.toContain(gone);
    const key = KEY_COLUMN.get(sort);
    if (key === undefined) {
      // keywords: the stored count is NOT NULL, so nothing is hidden.
      expect(rowsWhere).not.toContain('IS NOT NULL');
      expect(rowsWhere).not.toContain('keyword_count');
    } else {
      expect(rowsWhere.endsWith(` AND a.${key} IS NOT NULL`)).toBe(true);
    }
  });
  it('sorts by the stored keyword count in one level and hides nothing (spec 2026-10-23 §5)', () => {
    const desc = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords' }, EMPTY_CATEGORY_SCOPE);
    const t = desc.rows.text;
    // The column, not a count: no lateral and no read of the pair table, in the select list or the order.
    expect(t.startsWith('SELECT a.asin, ')).toBe(true);
    expect(t).toContain(COLUMNS_TAIL);
    expect(t.endsWith(" FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') ORDER BY a.keyword_count DESC, a.asin DESC LIMIT $1 OFFSET $2")).toBe(true);
    expect(t).not.toContain('LATERAL');
    expect(t).not.toContain('kc.');
    expect(t).not.toContain('keyword_top_asins');
    // keyword_count is NOT NULL: no IS NOT NULL predicate, in the rows or the count.
    expect(t).not.toContain('IS NOT NULL');
    expect(desc.rows.values).toEqual([50, 0]);
    expect(desc.count.text).toBe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') LIMIT ${PRODUCT_COUNT_CAP}) c`);
    expect(desc.count.values).toEqual([]);
    const asc = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords', dir: 'asc' }, EMPTY_CATEGORY_SCOPE).rows.text;
    expect(asc.endsWith(" FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') ORDER BY a.keyword_count ASC, a.asin ASC LIMIT $1 OFFSET $2")).toBe(true);
    expect(asc).not.toContain('LATERAL');
  });
  it('the keywords sort under a broad category (the combination spec 2026-10-23 §5 fixes): the semi-join, then the stored count orders the page', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords', broadCategory: 'Home' }, EMPTY_CATEGORY_SCOPE);
    const where = "a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = $1::text)";
    expect(q.rows.text.endsWith(` FROM asin_products a WHERE ${where} ORDER BY a.keyword_count DESC, a.asin DESC LIMIT $2 OFFSET $3`)).toBe(true);
    expect(q.rows.values).toEqual(['Home', 50, 0]);
    expect(q.count.text).toBe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE ${where} LIMIT ${PRODUCT_COUNT_CAP}) c`);
    expect(q.count.values).toEqual(['Home']);
  });
  it.each(PRODUCT_SORTS)('%s: the count statement is the capped count over the same WHERE, unchanged by the stored keyword count', (sort) => {
    const key = KEY_COLUMN.get(sort);
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, sort }, EMPTY_CATEGORY_SCOPE);
    expect(q.count.text).toBe(`SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price')${key === undefined ? '' : ` AND a.${key} IS NOT NULL`} LIMIT ${PRODUCT_COUNT_CAP}) c`);
    expect(q.count.values).toEqual([]);
  });
  it.each(PRODUCT_SORTS)('%s: selects the page columns, the stored keyword count among them (the Keywords column)', (sort) => {
    expect(selectNames(productSearchSql({ ...PRODUCT_DEFAULTS, sort }, EMPTY_CATEGORY_SCOPE).rows.text)).toEqual(new Set(Object.keys(RAW_ROW)));
  });
  it.each(PRODUCT_SORTS)('%s: names only real columns, of the catalog and the crosswalk alone', (sort) => {
    const scope: ProductCategoryScope = { dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: ['Tools › Bath › Mats'], scoped: true };
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, sort, age: 60, fba: 'yes', amazon: 'yes', ratioMax: 50, broadCategory: 'Home' }, scope).rows.text;
    expect(notIn(aliasCols(t, 'a'), dbCols(asinProducts))).toEqual([]);
    expect(aliasCols(t, 'a').has('keyword_count')).toBe(true);
    expect(notIn(aliasCols(t, 'x'), dbCols(baCategoryCrosswalk))).toEqual([]);
    // One level: it reads the catalog and the broad category's crosswalk, and no page subquery (p), keyword-count lateral (kc) or
    // pair-table read (k) is left.
    expect([...t.matchAll(/\bFROM (\w+)/g)].map((m) => m[1])).toEqual(['asin_products', 'ba_category_crosswalk']);
    for (const alias of ['p', 'kc', 'k']) expect([...aliasCols(t, alias)], `columns of ${alias}`).toEqual([]);
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
      return isCountStatement(text) ? [{ n: 3 }] : [RAW_ROW];
    };
    const r = await searchProducts(fake, PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE);
    expect(r.total).toBe(3);
    expect(r.totalIsCapped).toBe(false);
    expect(r).not.toHaveProperty('countTimedOut');
    // Every column maps, and nothing else: keywordCount is the stored keyword_count.
    expect(r.rows).toEqual([{
      asin: 'B000000001', title: 'Lamp', brand: 'Acme', categoryPath: 'Home & Kitchen › Lighting › Desk Lamps', listedSince: '2026-08-01', monthlySold: 1000, reviewCount: 120, averageRatingX10: 44,
      currentPriceCents: 1999, salesRank: 1234, rankRatioX100: 65, fbaOfferCount: 3, fbmOfferCount: 1, amazonAvailability: -1, enrichmentStatus: 'active', keywordCount: 7,
    }]);
    expect(calls).toHaveLength(2);
  });
  it.each(PRODUCT_SORTS)('%s: the mapper reads exactly the columns the rows statement selects', async (sort) => {
    const filters: ProductFilters = { ...PRODUCT_DEFAULTS, sort };
    const { row, read } = recordingRow({ ...RAW_ROW });
    await searchProducts(async (text) => (isCountStatement(text) ? [{ n: 1 }] : [row]), filters, EMPTY_CATEGORY_SCOPE);
    const selected = selectNames(productSearchSql(filters, EMPTY_CATEGORY_SCOPE).rows.text);
    expect(notIn(read, selected)).toEqual([]); // read but never selected: it would silently map to null (keywordCount to 0)
    expect(notIn(selected, read)).toEqual([]); // selected but never read: wasted
  });
  it('flags a capped total and defaults a missing keyword count to 0', async () => {
    const fake = async (text: string) => (isCountStatement(text) ? [{ n: PRODUCT_COUNT_CAP }] : [{ asin: 'B000000002', keyword_count: null }]);
    const r = await searchProducts(fake, { ...PRODUCT_DEFAULTS, page: 2 }, EMPTY_CATEGORY_SCOPE);
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
      const r = await searchProducts(fake, PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE);
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
        await expect(searchProducts(fake, PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE)).rejects.toBe(error);
      }
    });
    it('rejects when the rows statement times out: only the count is best-effort', async () => {
      const error = timeout();
      const fake = async (text: string) => {
        if (!isCountStatement(text)) throw error;
        return [{ n: 3 }];
      };
      await expect(searchProducts(fake, PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE)).rejects.toBe(error);
    });
    it('with the real neon driver: a 57014 on the count is a capped total, any other server error still rejects', async () => {
      const rowsResult = { command: 'SELECT', rowCount: 1, rows: [['B000000001']], fields: [{ name: 'asin', dataTypeID: 25 }], rowAsArray: true };
      // Each statement is its own batch (SET LOCAL, then the statement): fail the count's, answer the rows'.
      const serve = (onCount: FakeResponse) => (_url: string, batch: Batch) => (batch.queries[1].query.startsWith('SELECT count(*)') ? onCount : okResults(SET_RESULT, rowsResult));
      await withNeonFetch(serve(sqlError('57014', 'canceling statement due to statement timeout')), async (sql) => {
        const r = await searchProducts(neonRunner(sql), PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE);
        expect(r).toMatchObject({ total: PRODUCT_COUNT_CAP, totalIsCapped: true, countTimedOut: true });
        expect(r.rows.map((row) => row.asin)).toEqual(['B000000001']);
      });
      await withNeonFetch(serve(sqlError('53200', 'out of memory')), async (sql) => {
        await expect(searchProducts(neonRunner(sql), PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE)).rejects.toMatchObject({ name: 'NeonDbError', code: '53200' });
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
    const r = await searchProducts(neonRunner(sql), PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE);
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
  it('with the real neon client: an exact-path array travels as one Postgres array literal, quotes and backslashes escaped', async () => {
    const requests: Array<{ url: string; batch: Batch }> = [];
    await withNeonFetch(
      (url, batch) => {
        requests.push({ url, batch });
        return okResults(SET_RESULT, { command: 'SELECT', rowCount: 0, rows: [], fields: [], rowAsArray: true });
      },
      async (sql) => {
        // The third path holds a double quote, a comma and one backslash (two in the source).
        const exactPaths = ['Pet Supplies › Dogs › Toys', 'Pet Supplies › Cats › Toys', 'Toys › "Plush", Soft\\Cuddly'];
        const q = productSearchSql(PRODUCT_DEFAULTS, { ...EMPTY_CATEGORY_SCOPE, exactPaths, scoped: true });
        await neonRunner(sql)(q.count.text, q.count.values);
      },
    );
    // pg's arrayString quotes every element and escapes `"` and `\` with a backslash; String.raw shows the wire text as sent.
    expect(requests[0].batch.queries[1].params).toEqual([String.raw`{"Pet Supplies › Dogs › Toys","Pet Supplies › Cats › Toys","Toys › \"Plush\", Soft\\Cuddly"}`]);
  });
});
