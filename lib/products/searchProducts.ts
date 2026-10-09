// lib/products/searchProducts.ts
/**
 * Product search over the live catalog (spec 2026-10-09 §5). Pure statement builder + a loader
 * over a `(text, values) => rows` runner (the page wraps neon's `sql.query`; the tools reuse it).
 * Every predicate rides on a partial index from migration 0051; the base predicate matches those
 * indexes' WHERE clause exactly.
 *
 * Two rules keep a page cheap on a multi-million-row catalog:
 *  - Page first, count second. The filter, the order and the 50-row page are a subquery (it also
 *    carries the raw sort value as `sort_key`); the lateral keyword count joins only those rows
 *    (spec §5.2) and the outer ORDER BY restates the order, since a join promises none. The
 *    `keywords` sort is the exception: it orders by the count, so it stays single-level and its
 *    lateral runs for every candidate row.
 *  - Sorts hide rows whose sort key is NULL (the explorer's rule for its avg sorts). The WHERE gets
 *    `<key> IS NOT NULL`, the ORDER BY has no NULLS clause, and its `asin` tie-breaker runs in the
 *    sort direction, so the order is exactly a forward (ASC) or backward (DESC) scan of the key's
 *    `(<key>, asin)` partial index and the top-N comes off the index instead of sorting every
 *    candidate. The tie-breaker stays: without a total order, rows could repeat or skip across
 *    pages when updates move rows inside a tie. The page says so with SORT_KEY_LABEL.
 */
import { PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE, type ProductFilters } from './filters';

/** Exact up to the pager's last reachable row (200 pages of 50), then "10,000+". */
export const PRODUCT_COUNT_CAP = PRODUCT_MAX_PAGE * PRODUCT_PAGE_SIZE;
export interface SqlStatement { text: string; values: unknown[] }
export type SqlRunner = (text: string, values: unknown[]) => Promise<unknown[]>;

export interface ProductSummaryRow {
  asin: string; title: string | null; brand: string | null; listedSince: string | null; monthlySold: number | null; reviewCount: number | null;
  averageRatingX10: number | null; currentPriceCents: number | null; salesRank: number | null; rankRatioX100: number | null;
  fbaOfferCount: number | null; fbmOfferCount: number | null; amazonAvailability: number | null; enrichmentStatus: 'active' | 'no_price'; keywordCount: number;
}
export interface ProductSearchResult { rows: ProductSummaryRow[]; total: number; totalIsCapped: boolean; page: number; pageSize: number }

const BASE = "a.in_scope AND a.enrichment_status IN ('active', 'no_price')";

/** Every sort but `keywords` orders by a nullable catalog column. */
export type NullableKeySort = Exclude<ProductFilters['sort'], 'keywords'>;
const SORT_COLUMN: Record<NullableKeySort, string> = {
  sold: 'monthly_sold', listed: 'listed_since', reviews: 'review_count', price: 'current_price_cents', bsr: 'sales_rank', ratio: 'rank_ratio_x100',
};
/** The field each hiding sort orders by, for the page's "Products without a <field> are hidden under this sort." hint. */
export const SORT_KEY_LABEL: Readonly<Record<NullableKeySort, string>> = {
  sold: 'monthly sold badge', listed: 'listing date', reviews: 'review count', price: 'price', bsr: 'BSR', ratio: 'BSR ratio',
};
/** True when the sort drops rows whose sort key is NULL: every sort but `keywords` (a count is never NULL). */
export function sortHidesNullKey(sort: ProductFilters['sort']): sort is NullableKeySort {
  return sort !== 'keywords';
}

const PAGE_COLUMNS = `a.asin, a.title, a.brand, a.listed_since::text AS listed_since, a.monthly_sold, a.review_count, a.average_rating_x10,
  CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents,
  a.sales_rank, a.rank_ratio_x100, a.fba_offer_count, a.fbm_offer_count, a.amazon_availability, a.enrichment_status::text AS enrichment_status`;
/** The current top-3 keyword count of the rows of `alias` (the catalog itself, or the page subquery). */
const keywordCount = (alias: 'a' | 'p') => `LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = ${alias}.asin) kc ON true`;

export function productSearchSql(f: ProductFilters): { rows: SqlStatement; count: SqlStatement } {
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
  if (f.cat !== null) where.push(`(a.category_path = ${bind(f.cat)}::text OR starts_with(a.category_path, ${bind(`${f.cat} › `)}::text))`);
  if (f.fba === 'yes') where.push('a.fba_offer_count > 0');
  if (f.fba === 'no') where.push('a.fba_offer_count = 0');
  if (f.amazon === 'yes') where.push('a.amazon_availability >= 0');
  if (f.amazon === 'no') where.push('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  const keyColumn = sortHidesNullKey(f.sort) ? SORT_COLUMN[f.sort] : null;
  if (keyColumn !== null) where.push(`a.${keyColumn} IS NOT NULL`);
  const whereSql = where.join(' AND ');
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const whereValues = [...values];
  const limit = bind(PRODUCT_PAGE_SIZE);
  const offset = bind((f.page - 1) * PRODUCT_PAGE_SIZE);
  const rows = keyColumn === null
    // Ordered by the count itself, so it stays single-level: the lateral runs for every candidate row.
    ? `SELECT ${PAGE_COLUMNS}, kc.keyword_count FROM asin_products a ${keywordCount('a')} WHERE ${whereSql} ORDER BY kc.keyword_count ${dir}, a.asin ${dir} LIMIT ${limit} OFFSET ${offset}`
    // Page first, count second: the subquery is the filtered, ordered page, with the raw sort value as sort_key
    // (not the ::text date or the masked price); only its rows get the lateral count, and the outer ORDER BY
    // restates the order.
    : `SELECT p.*, kc.keyword_count FROM (SELECT ${PAGE_COLUMNS}, a.${keyColumn} AS sort_key FROM asin_products a WHERE ${whereSql} ORDER BY a.${keyColumn} ${dir}, a.asin ${dir} LIMIT ${limit} OFFSET ${offset}) p ${keywordCount('p')} ORDER BY p.sort_key ${dir}, p.asin ${dir}`;
  return {
    rows: { text: rows, values },
    count: { text: `SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE ${whereSql} LIMIT ${PRODUCT_COUNT_CAP}) c`, values: whereValues },
  };
}

/** A result row. The page-first statement also returns `sort_key` (for its outer re-sort); the mapper does not read it. */
interface Raw { asin: string; title: string | null; brand: string | null; listed_since: string | null; monthly_sold: number | null; review_count: number | null; average_rating_x10: number | null; current_price_cents: number | null; sales_rank: number | null; rank_ratio_x100: number | null; fba_offer_count: number | null; fbm_offer_count: number | null; amazon_availability: number | null; enrichment_status: 'active' | 'no_price'; keyword_count: number | null }

export async function searchProducts(run: SqlRunner, f: ProductFilters): Promise<ProductSearchResult> {
  const q = productSearchSql(f);
  const [rows, count] = await Promise.all([run(q.rows.text, q.rows.values) as Promise<Raw[]>, run(q.count.text, q.count.values) as Promise<Array<{ n: number }>>]);
  const total = count[0]?.n ?? 0;
  return {
    rows: rows.map((r) => ({
      asin: r.asin, title: r.title, brand: r.brand, listedSince: r.listed_since, monthlySold: r.monthly_sold, reviewCount: r.review_count, averageRatingX10: r.average_rating_x10,
      currentPriceCents: r.current_price_cents, salesRank: r.sales_rank, rankRatioX100: r.rank_ratio_x100, fbaOfferCount: r.fba_offer_count, fbmOfferCount: r.fbm_offer_count,
      amazonAvailability: r.amazon_availability, enrichmentStatus: r.enrichment_status, keywordCount: r.keyword_count ?? 0,
    })),
    total, totalIsCapped: total >= PRODUCT_COUNT_CAP, page: f.page, pageSize: PRODUCT_PAGE_SIZE,
  };
}

/**
 * The page's runner: neon's query form (positional parameters), one statement per call.
 * `@neondatabase/serverless` 1.x exposes `sql.query(text, params)` on the `neon()` client
 * (verified against the installed 1.0.2 typings); with the default `fullResults: false` it
 * resolves to the row array.
 */
export function neonRunner(sql: { query: (text: string, values?: unknown[]) => Promise<unknown> }): SqlRunner {
  return async (text, values) => (await sql.query(text, values)) as unknown[];
}
