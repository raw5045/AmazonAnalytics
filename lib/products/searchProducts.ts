// lib/products/searchProducts.ts
/**
 * Product search over the live catalog (spec 2026-10-09 §5). Pure statement builder + a loader
 * over a `(text, values) => rows` runner (the page wraps neon's client in `neonRunner`; the tools reuse it).
 * The category filter is a ProductCategoryScope built by the caller — see ./categoryPredicate; every
 * other filter is read from ProductFilters (spec 2026-10-12 §4.3).
 * The indexes behind the predicates: the 0051 (key, asin) partial indexes for the range filters and sorts,
 * and 0056's asin_products_keyword_count_idx for the keywords sort (the base predicate matches their WHERE
 * clause exactly, which is what lets the planner use a partial index at all), 0050's partial
 * asin_products_category_path_idx for the category predicate (see ./categoryPredicate), and 0053's
 * ba_category_crosswalk_code_idx (a plain index on the small crosswalk) for the broad-category semi-join.
 * Rating, FBA and Amazon have no index of their own and ride whichever scan the planner picks.
 *
 * Two rules keep a page cheap on a multi-million-row catalog:
 *  - Every sort has an index to walk. Each one orders by a stored catalog column and nothing is
 *    joined to the page (the Keywords column is the stored count too), so the statement is one level:
 *    the filter, the order and the 50-row page. The ORDER BY has no NULLS clause and its `asin`
 *    tie-breaker runs in the sort direction, so the order is exactly a forward (ASC) or backward
 *    (DESC) scan of the key's `(<key>, asin)` partial index and the top-N can come off the index
 *    instead of sorting every candidate. The tie-breaker stays: without a total order, rows could
 *    repeat or skip across pages when updates move rows inside a tie.
 *  - Sorts hide rows whose sort key is NULL (the explorer's rule for its avg sorts): the WHERE gets
 *    `<key> IS NOT NULL`, and the page says so with SORT_KEY_LABEL. keyword_count is NOT NULL, so
 *    the keywords sort hides nothing and gets no such predicate.
 *
 * The keywords sort (spec 2026-10-23 §5) walks asin_products_keyword_count_idx, partial on the base
 * predicate like 0051's six, as the other sorts walk theirs. keyword_count is the stored current-week
 * count of keywords the product is a top-3 clicked product for, written weekly by the import's
 * keyword_counts_build phase right after top_asins_build rebuilds keyword_top_asins
 * (./buildKeywordCounts); the pair table changes only at imports, so the weekly write is exact. Before
 * 0056 the sort counted keywords with a lateral subquery per candidate row, and a wide filter (broad
 * category Home: ~315k probes before the sort) ran past the 30 s cap cold. The cap stays as the
 * safety net (see neonRunner).
 *
 * The total is best-effort: a count that hits the statement timeout (57014) yields the capped total
 * and `countTimedOut`, so a slow count never costs the page its rows. A rows statement that hits it still
 * rejects; the list page tells that apart with isStatementTimeout and shows its inline notice.
 */
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { categoryPredicate, type ProductCategoryScope } from './categoryPredicate';
import { PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE, sortHidesNullKey, type NullableKeySort, type ProductFilters } from './filterParams';

// The sort-key rule lives in ./filterParams (zod-free, for the page's client components); re-exported for existing imports.
export { SORT_KEY_LABEL, sortHidesNullKey, type NullableKeySort } from './filterParams';

/** Exact up to the pager's last reachable row (200 pages of 50), then "10,000+". */
export const PRODUCT_COUNT_CAP = PRODUCT_MAX_PAGE * PRODUCT_PAGE_SIZE;
/** Server-side cap, in milliseconds, on every product read that goes through `neonRunner`. */
export const PRODUCT_READ_TIMEOUT_MS = 30_000;
export interface SqlStatement { text: string; values: unknown[] }
export type SqlRunner = (text: string, values: unknown[]) => Promise<unknown[]>;

export interface ProductSummaryRow {
  asin: string; title: string | null; brand: string | null; categoryPath: string | null; listedSince: string | null; monthlySold: number | null; reviewCount: number | null;
  averageRatingX10: number | null; currentPriceCents: number | null; salesRank: number | null; rankRatioX100: number | null;
  fbaOfferCount: number | null; fbmOfferCount: number | null; amazonAvailability: number | null; enrichmentStatus: 'active' | 'no_price'; keywordCount: number;
}
export interface ProductSearchResult {
  rows: ProductSummaryRow[]; total: number; totalIsCapped: boolean; page: number; pageSize: number;
  /** True when the count hit the statement timeout: `total` is then the cap and `totalIsCapped` is true. Absent otherwise. */
  countTimedOut?: boolean;
}

/**
 * The list's base predicate, over alias `a`: the first term of every statement's WHERE. The seven partial (key, asin)
 * indexes (0051's six, 0056's asin_products_keyword_count_idx) carry exactly this predicate, alias aside, which is what
 * lets the planner use them; searchProducts.test.ts pins it to both migrations, so an edit here cannot silently disable them.
 */
export const BASE = "a.in_scope AND a.enrichment_status IN ('active', 'no_price')";

/** The catalog column each nullable-key sort orders by (and hides the NULLs of). */
const SORT_COLUMN: Record<NullableKeySort, string> = {
  sold: 'monthly_sold', listed: 'listed_since', reviews: 'review_count', price: 'current_price_cents', bsr: 'sales_rank', ratio: 'rank_ratio_x100',
};

const PAGE_COLUMNS = `a.asin, a.title, a.brand, a.category_path, a.listed_since::text AS listed_since, a.monthly_sold, a.review_count, a.average_rating_x10,
  CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents,
  a.sales_rank, a.rank_ratio_x100, a.fba_offer_count, a.fbm_offer_count, a.amazon_availability, a.keyword_count, a.enrichment_status::text AS enrichment_status`;

export function productSearchSql(f: ProductFilters, scope: ProductCategoryScope): { rows: SqlStatement; count: SqlStatement } {
  const where: string[] = [BASE];
  const values: unknown[] = [];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  if (f.age !== null) where.push(`a.listed_since >= current_date - ${bind(f.age)}::int`);
  if (f.soldMin !== null) where.push(`a.monthly_sold >= ${bind(f.soldMin)}::int`);
  if (f.reviewsMax !== null) where.push(`a.review_count <= ${bind(f.reviewsMax)}::int`);
  if (f.ratingMin !== null) where.push(`a.average_rating_x10 >= ${bind(f.ratingMin)}::int`);
  if (f.ratingMax !== null) where.push(`a.average_rating_x10 <= ${bind(f.ratingMax)}::int`);
  if (f.priceMinCents !== null) where.push(`a.current_price_cents >= ${bind(f.priceMinCents)}::int`);
  if (f.priceMaxCents !== null) where.push(`a.current_price_cents <= ${bind(f.priceMaxCents)}::int`);
  if (f.bsrMin !== null) where.push(`a.sales_rank >= ${bind(f.bsrMin)}::int`);
  if (f.bsrMax !== null) where.push(`a.sales_rank <= ${bind(f.bsrMax)}::int`);
  if (f.ratioMax !== null) where.push(`a.rank_ratio_x100 <= ${bind(f.ratioMax)}::int`);
  // The category filter comes from the scope alone (spec 2026-10-12 §4.1); f's own category fields are the URL's, not the query's.
  const category = categoryPredicate(scope, bind);
  if (category !== null) where.push(category);
  // The product's broad category is the code of its Keepa path (spec 2026-10-14 §6): a semi-join against the code's paths.
  // ba_category_crosswalk_code_idx serves the subquery (the code's paths, or one probe per candidate when a sort index drives); asin_products_category_path_idx can serve the probes into the catalog when the code's paths drive.
  if (f.broadCategory !== null) where.push(`a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = ${bind(f.broadCategory)}::text)`);
  if (f.fba === 'yes') where.push('a.fba_offer_count > 0');
  if (f.fba === 'no') where.push('a.fba_offer_count = 0');
  if (f.amazon === 'yes') where.push('a.amazon_availability >= 0');
  if (f.amazon === 'no') where.push('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  // The sort's column: the stored keyword count (NOT NULL, so the keywords sort hides nothing), else a nullable catalog column whose NULLs the sort hides.
  const keyColumn = f.sort === 'keywords' ? 'keyword_count' : SORT_COLUMN[f.sort];
  if (sortHidesNullKey(f.sort)) where.push(`a.${keyColumn} IS NOT NULL`);
  const whereSql = where.join(' AND ');
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const whereValues = [...values];
  const limit = bind(PRODUCT_PAGE_SIZE);
  const offset = bind((f.page - 1) * PRODUCT_PAGE_SIZE);
  // One level for every sort: nothing is joined to the page, so the ORDER BY on the raw column (not the ::text date or the
  // masked price) is the order of the sort's (key, asin) index, which the planner can walk and stop at the page.
  const rows = `SELECT ${PAGE_COLUMNS} FROM asin_products a WHERE ${whereSql} ORDER BY a.${keyColumn} ${dir}, a.asin ${dir} LIMIT ${limit} OFFSET ${offset}`;
  return {
    rows: { text: rows, values },
    count: { text: `SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE ${whereSql} LIMIT ${PRODUCT_COUNT_CAP}) c`, values: whereValues },
  };
}

/** A result row: the columns of PAGE_COLUMNS. keyword_count is NOT NULL in the table; the mapper still reads a missing one as 0. */
interface Raw { asin: string; title: string | null; brand: string | null; category_path: string | null; listed_since: string | null; monthly_sold: number | null; review_count: number | null; average_rating_x10: number | null; current_price_cents: number | null; sales_rank: number | null; rank_ratio_x100: number | null; fba_offer_count: number | null; fbm_offer_count: number | null; amazon_availability: number | null; enrichment_status: 'active' | 'no_price'; keyword_count: number | null }

/** SQLSTATE 57014 (query_canceled), what a statement timeout raises; pg's DatabaseError and neon's NeonDbError both carry it as `.code`. */
const STATEMENT_TIMEOUT = '57014';
/** Whether an error is the statement timeout the runners set (SQLSTATE 57014, query_canceled). */
export function isStatementTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === STATEMENT_TIMEOUT;
}

/** The capped count, or `null` when it hit the statement timeout. Any other failure rejects. */
async function cappedCount(run: SqlRunner, q: SqlStatement): Promise<number | null> {
  try {
    return ((await run(q.text, q.values)) as Array<{ n: number }>)[0]?.n ?? 0;
  } catch (e) {
    if (isStatementTimeout(e)) return null;
    throw e;
  }
}

export async function searchProducts(run: SqlRunner, f: ProductFilters, scope: ProductCategoryScope): Promise<ProductSearchResult> {
  const q = productSearchSql(f, scope);
  // The count is best-effort, like the explorer's: rows and count run in parallel, and a count that hits the
  // statement timeout costs the exact total (it becomes the capped one), never the page. A failing rows
  // statement, or any other count failure, still rejects.
  const [rows, counted] = await Promise.all([run(q.rows.text, q.rows.values) as Promise<Raw[]>, cappedCount(run, q.count)]);
  const countTimedOut = counted === null;
  const total = counted ?? PRODUCT_COUNT_CAP;
  return {
    rows: rows.map((r) => ({
      asin: r.asin, title: r.title, brand: r.brand, categoryPath: r.category_path, listedSince: r.listed_since, monthlySold: r.monthly_sold, reviewCount: r.review_count, averageRatingX10: r.average_rating_x10,
      currentPriceCents: r.current_price_cents, salesRank: r.sales_rank, rankRatioX100: r.rank_ratio_x100, fbaOfferCount: r.fba_offer_count, fbmOfferCount: r.fbm_offer_count,
      amazonAvailability: r.amazon_availability, enrichmentStatus: r.enrichment_status, keywordCount: r.keyword_count ?? 0,
    })),
    total, totalIsCapped: total >= PRODUCT_COUNT_CAP, page: f.page, pageSize: PRODUCT_PAGE_SIZE,
    ...(countTimedOut ? { countTimedOut: true } : {}),
  };
}

/** The slice of a `neon()` client the runner uses: lazy positional-parameter queries and the batch transaction. */
export type NeonRunnerSql = Pick<NeonQueryFunction<false, false>, 'query' | 'transaction'>;

/**
 * The page's runner: neon's query form (positional parameters), one statement per call, run as its
 * own HTTP transaction behind `SET LOCAL statement_timeout` so a slow read is cancelled server-side
 * after PRODUCT_READ_TIMEOUT_MS: the safety net for any slow combination of filters and sort. It used
 * to matter most for `sort=keywords` on wide filters, which counted keywords for the whole catalog
 * while holding a read lock on keyword_top_asins, the lock an import's table swap waits on (120 s,
 * then the build fails soft and the reverse table stays a week behind). The keywords sort now reads
 * the stored keyword_count (spec 2026-10-23 §5), so the search no longer reads that table and that
 * wait no longer applies to it. `@neondatabase/serverless` 1.x (checked against 1.0.2):
 * `sql.query()` only builds a lazy query, and `sql.transaction([...])` submits the batch as one
 * transaction and resolves to one row array per statement under the default options, so the
 * query's rows are the last element.
 */
export function neonRunner(sql: NeonRunnerSql): SqlRunner {
  return async (text, values) => {
    const results = await sql.transaction([sql.query(`SET LOCAL statement_timeout = ${PRODUCT_READ_TIMEOUT_MS}`), sql.query(text, values)]);
    return results[results.length - 1];
  };
}
