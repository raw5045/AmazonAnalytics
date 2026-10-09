// lib/products/searchProducts.ts
/**
 * Product search over the live catalog (spec 2026-10-09 §5). Pure statement builder + a loader
 * over a `(text, values) => rows` runner (the page wraps neon's `sql.query`; the tools reuse it).
 * Every predicate rides on a partial index from migration 0051; the base predicate matches those
 * indexes' WHERE clause exactly.
 */
import { PRODUCT_PAGE_SIZE, type ProductFilters } from './filters';

export const PRODUCT_COUNT_CAP = 10_000;
export interface SqlStatement { text: string; values: unknown[] }
export type SqlRunner = (text: string, values: unknown[]) => Promise<unknown[]>;

export interface ProductSummaryRow {
  asin: string; title: string | null; brand: string | null; listedSince: string | null; monthlySold: number | null; reviewCount: number | null;
  averageRatingX10: number | null; currentPriceCents: number | null; salesRank: number | null; rankRatioX100: number | null;
  fbaOfferCount: number | null; fbmOfferCount: number | null; amazonAvailability: number | null; enrichmentStatus: 'active' | 'no_price'; keywordCount: number;
}
export interface ProductSearchResult { rows: ProductSummaryRow[]; total: number; totalIsCapped: boolean; page: number; pageSize: number }

const BASE = "a.in_scope AND a.enrichment_status IN ('active', 'no_price')";
const SORT_COLUMN: Record<ProductFilters['sort'], string> = {
  sold: 'a.monthly_sold', listed: 'a.listed_since', reviews: 'a.review_count', price: 'a.current_price_cents', bsr: 'a.sales_rank', ratio: 'a.rank_ratio_x100', keywords: 'kc.keyword_count',
};
const SELECT = `a.asin, a.title, a.brand, a.listed_since::text AS listed_since, a.monthly_sold, a.review_count, a.average_rating_x10,
  CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents,
  a.sales_rank, a.rank_ratio_x100, a.fba_offer_count, a.fbm_offer_count, a.amazon_availability, a.enrichment_status::text AS enrichment_status, kc.keyword_count`;
const KEYWORD_COUNT = 'LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = a.asin) kc ON true';

export function productSearchSql(f: ProductFilters): { rows: SqlStatement; count: SqlStatement } {
  const where: string[] = [BASE];
  const values: unknown[] = [];
  const p = (v: unknown) => { values.push(v); return `$${values.length}`; };
  if (f.age !== null) where.push(`a.listed_since >= current_date - ${p(f.age)}::int`);
  if (f.soldMin !== null) where.push(`a.monthly_sold >= ${p(f.soldMin)}::int`);
  if (f.reviewsMax !== null) where.push(`a.review_count <= ${p(f.reviewsMax)}::int`);
  if (f.ratingMin !== null) where.push(`a.average_rating_x10 >= ${p(f.ratingMin)}::int`);
  if (f.ratingMax !== null) where.push(`a.average_rating_x10 <= ${p(f.ratingMax)}::int`);
  if (f.priceMinCents !== null) where.push(`a.current_price_cents >= ${p(f.priceMinCents)}::int`);
  if (f.priceMaxCents !== null) where.push(`a.current_price_cents <= ${p(f.priceMaxCents)}::int`);
  if (f.bsrMin !== null) where.push(`a.sales_rank >= ${p(f.bsrMin)}::int`);
  if (f.bsrMax !== null) where.push(`a.sales_rank <= ${p(f.bsrMax)}::int`);
  if (f.ratioMax !== null) where.push(`a.rank_ratio_x100 <= ${p(f.ratioMax)}::int`);
  if (f.cat !== null) where.push(`(a.category_path = ${p(f.cat)}::text OR starts_with(a.category_path, ${p(`${f.cat} › `)}::text))`);
  if (f.fba === 'yes') where.push('a.fba_offer_count > 0');
  if (f.fba === 'no') where.push('a.fba_offer_count = 0');
  if (f.amazon === 'yes') where.push('a.amazon_availability >= 0');
  if (f.amazon === 'no') where.push('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  const whereSql = where.join(' AND ');
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const order = `ORDER BY ${SORT_COLUMN[f.sort]} ${dir} NULLS LAST, a.asin`;
  const whereValues = [...values];
  const limit = p(PRODUCT_PAGE_SIZE);
  const offset = p((f.page - 1) * PRODUCT_PAGE_SIZE);
  return {
    rows: { text: `SELECT ${SELECT} FROM asin_products a ${KEYWORD_COUNT} WHERE ${whereSql} ${order} LIMIT ${limit} OFFSET ${offset}`, values },
    count: { text: `SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE ${whereSql} LIMIT ${PRODUCT_COUNT_CAP}) c`, values: whereValues },
  };
}

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
