// lib/products/loadProduct.ts
/**
 * The ASIN page's facts card (spec 2026-10-09 §6.1): one catalog row by ASIN, plus a title from
 * the keyword side when the catalog has none (an ASIN the Keepa service has not fetched yet), plus
 * the ASIN's Brand Analytics codes from the reverse table, most keywords first (spec 2026-10-12 §8).
 *
 * The catalog KEEPS every fact on a delisted row (the service's delisted write leaves them in
 * place); this reader hides them, as mapEnrichedProducts (lib/explorer/fetchKeywordDetail.ts) does
 * for the keyword page: prices come through only for an `active` row, and a `delisted` row also
 * loses its point-in-time facts (sales rank, its averages and ratio, monthly sold, the offer
 * counts, Amazon availability). Title, brand, category, image, reviews, rating and the dates always
 * come through. Deliberately no in_scope or status predicate: a direct link opens out-of-scope and
 * delisted rows too.
 *
 * An ASIN can be in the keyword tables without being in the catalog (the enqueue leaves some
 * categories out). The loader then returns a stub with `inCatalog: false` and no catalog facts (it
 * still carries the codes), so the page can say "Not in the Keepa catalog" and still list the
 * keywords. Null means neither table has it.
 */
import type { AsinEnrichmentStatus } from '@/db/schema';
import type { SqlRunner, SqlStatement } from './searchProducts';

/** What the ASIN page's facts card (and the product-details tool) shows for one ASIN. Dates are YYYY-MM-DD strings. */
export interface ProductFacts {
  asin: string;
  /** The catalog title, else the slot-1 title from the keyword side; null when neither exists (show the bare ASIN). */
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  categoryPath: string | null;
  listedSince: string | null;
  trackingSince: string | null;
  /** Null unless the status is 'active'; so are the four averages. */
  currentPriceCents: number | null;
  avg30PriceCents: number | null;
  avg90PriceCents: number | null;
  avg180PriceCents: number | null;
  avg365PriceCents: number | null;
  /** Point-in-time: null for a delisted row, and so are the 30/90-day averages, the ratio, monthlySold, the offer counts and amazonAvailability. */
  salesRank: number | null;
  avg30SalesRank: number | null;
  avg90SalesRank: number | null;
  /** round(100 × salesRank ÷ avg30SalesRank); below 100 = ranked better than its own 30-day average. */
  rankRatioX100: number | null;
  reviewCount: number | null;
  /** 0–50 scale (divide by 10 for stars). */
  averageRatingX10: number | null;
  lastRatingUpdate: string | null;
  /** Amazon's "bought in past month" floor (100000 = 100K+); null without the badge. */
  monthlySold: number | null;
  /** Keepa's lastUpdate: the "as of" date for monthlySold and the offer counts. */
  keepaUpdatedAt: string | null;
  newOfferCount: number | null;
  fbaOfferCount: number | null;
  fbmOfferCount: number | null;
  /** Keepa code: −1 no Amazon offer, 0 in stock, 1 pre-order, 2 unknown, 3 back-order, 4 delayed (see availabilityLabel). */
  amazonAvailability: number | null;
  /** Null until the service has a fetch outcome for the ASIN. */
  enrichmentStatus: AsinEnrichmentStatus | null;
  /**
   * False for a stub: an ASIN the keyword tables know but the catalog has no row for (e.g. an
   * excluded category). Every catalog fact is then null (counts 0, inScope false, tier 0; only
   * broadCategories can be set); the page says "Not in the Keepa catalog".
   */
  inCatalog: boolean;
  /** False until the service has fetched the ASIN once (last_fetched_at is null): the facts above are then all null. */
  fetched: boolean;
  /** ISO timestamp of the last fetch; null when never fetched (or the stored value cannot be read as a time). */
  lastFetchedAt: string | null;
  fetchCount: number;
  inScope: boolean;
  /** The best (lowest) keyword rank among the keywords the ASIN was a top-3 clicked product for in the scope week; null when it has none. */
  bestRank: number | null;
  /** The service's refresh tier, 1 or 2 (1 = refreshed more often); 0 on a stub. */
  tier: number;
  /** The Brand Analytics codes of the ASIN's pair rows this week, most keywords first; [] when it has none or none coded (spec 2026-10-12 broad category §8). */
  broadCategories: string[];
}

const FACTS_COLUMNS = `a.asin, a.title, a.brand, a.image_url, a.category_path,
  a.listed_since::text AS listed_since, a.tracking_since::text AS tracking_since,
  a.current_price_cents, a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
  a.sales_rank, a.avg30_sales_rank, a.avg90_sales_rank, a.rank_ratio_x100,
  a.review_count, a.average_rating_x10, a.last_rating_update::text AS last_rating_update,
  a.monthly_sold, a.keepa_updated_at::text AS keepa_updated_at,
  a.new_offer_count, a.fba_offer_count, a.fbm_offer_count, a.amazon_availability,
  a.enrichment_status::text AS enrichment_status, a.last_fetched_at, a.fetch_count, a.in_scope, a.best_rank, a.tier`;

/** One catalog row by primary key. The only predicate is the ASIN. */
export function productFactsSql(asin: string): SqlStatement {
  return { text: `SELECT ${FACTS_COLUMNS} FROM asin_products a WHERE a.asin = $1`, values: [asin] };
}

/**
 * A title for an ASIN the catalog has none for, from the keyword side: titles live only on the
 * keyword tables, and keyword_current_summary holds the slot-1 title. Two guards:
 *  - the summary's slot-1 ASIN must be THIS ASIN. The reverse table is built at import time and the
 *    summary is refreshed hours later, so in between a keyword's summary row can still hold last
 *    week's slot-1 product, and its title would be some other product's;
 *  - rows without a title are skipped, so LIMIT 1 cannot land on one when another keyword has it.
 */
export function productFallbackTitleSql(asin: string): SqlStatement {
  return {
    text: `SELECT kcs.top_clicked_product_1_title_current AS title
FROM keyword_top_asins k
JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id
WHERE k.asin = $1 AND k.slot = 1 AND kcs.top_clicked_product_1_asin_current = k.asin
  AND kcs.top_clicked_product_1_title_current IS NOT NULL
LIMIT 1`,
    values: [asin],
  };
}

/** Is the ASIN in the reverse table at all? Decides between a stub and a 404 when the catalog has no row. */
export function productTrackedSql(asin: string): SqlStatement {
  return { text: 'SELECT 1 FROM keyword_top_asins k WHERE k.asin = $1 LIMIT 1', values: [asin] };
}

/** The ASIN's codes on the pair table, most keywords first (ties by code), through keyword_top_asins_asin_idx. */
export function productBroadCategoriesSql(asin: string): SqlStatement {
  return {
    text: `SELECT k.broad_category FROM keyword_top_asins k
WHERE k.asin = $1 AND k.broad_category IS NOT NULL
GROUP BY k.broad_category ORDER BY count(*) DESC, k.broad_category`,
    values: [asin],
  };
}

interface FactsRow {
  asin: string;
  title: string | null;
  brand: string | null;
  image_url: string | null;
  category_path: string | null;
  listed_since: string | null;
  tracking_since: string | null;
  current_price_cents: number | null;
  avg30_price_cents: number | null;
  avg90_price_cents: number | null;
  avg180_price_cents: number | null;
  avg365_price_cents: number | null;
  sales_rank: number | null;
  avg30_sales_rank: number | null;
  avg90_sales_rank: number | null;
  rank_ratio_x100: number | null;
  review_count: number | null;
  average_rating_x10: number | null;
  last_rating_update: string | null;
  monthly_sold: number | null;
  keepa_updated_at: string | null;
  new_offer_count: number | null;
  fba_offer_count: number | null;
  fbm_offer_count: number | null;
  amazon_availability: number | null;
  enrichment_status: AsinEnrichmentStatus | null;
  last_fetched_at: Date | string | null;
  fetch_count: number;
  in_scope: boolean;
  best_rank: number | null;
  tier: number;
}

const nonBlank = (s: string | null | undefined): string | null => (typeof s === 'string' && s.trim() !== '' ? s : null);
/** neon hands back a timestamptz as a Date; a runner that returns text works too. A value that is not a time reads as null. */
const isoTimestamp = (v: Date | string): string | null => {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function toFacts(r: FactsRow, title: string | null, broadCategories: string[]): ProductFacts {
  const status = r.enrichment_status ?? null;
  const ifActive = (v: number | null | undefined): number | null => (status === 'active' ? (v ?? null) : null);
  const unlessDelisted = (v: number | null | undefined): number | null => (status === 'delisted' ? null : (v ?? null));
  const lastFetchedAt = r.last_fetched_at ?? null;
  return {
    asin: r.asin,
    title,
    brand: r.brand ?? null,
    imageUrl: r.image_url ?? null,
    categoryPath: r.category_path ?? null,
    listedSince: r.listed_since ?? null,
    trackingSince: r.tracking_since ?? null,
    currentPriceCents: ifActive(r.current_price_cents),
    avg30PriceCents: ifActive(r.avg30_price_cents),
    avg90PriceCents: ifActive(r.avg90_price_cents),
    avg180PriceCents: ifActive(r.avg180_price_cents),
    avg365PriceCents: ifActive(r.avg365_price_cents),
    salesRank: unlessDelisted(r.sales_rank),
    avg30SalesRank: unlessDelisted(r.avg30_sales_rank),
    avg90SalesRank: unlessDelisted(r.avg90_sales_rank),
    rankRatioX100: unlessDelisted(r.rank_ratio_x100),
    reviewCount: r.review_count ?? null,
    averageRatingX10: r.average_rating_x10 ?? null,
    lastRatingUpdate: r.last_rating_update ?? null,
    monthlySold: unlessDelisted(r.monthly_sold),
    keepaUpdatedAt: r.keepa_updated_at ?? null,
    newOfferCount: unlessDelisted(r.new_offer_count),
    fbaOfferCount: unlessDelisted(r.fba_offer_count),
    fbmOfferCount: unlessDelisted(r.fbm_offer_count),
    amazonAvailability: unlessDelisted(r.amazon_availability),
    enrichmentStatus: status,
    inCatalog: true,
    fetched: lastFetchedAt !== null,
    lastFetchedAt: lastFetchedAt === null ? null : isoTimestamp(lastFetchedAt),
    fetchCount: r.fetch_count,
    inScope: r.in_scope,
    bestRank: r.best_rank ?? null,
    tier: r.tier,
    broadCategories,
  };
}

/** What the page gets for an ASIN the keyword tables know but the catalog does not: no catalog facts at all, only the keyword side's title and codes. */
function untrackedStub(asin: string, title: string | null, broadCategories: string[]): ProductFacts {
  return {
    asin, title, brand: null, imageUrl: null, categoryPath: null, listedSince: null, trackingSince: null,
    currentPriceCents: null, avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null,
    salesRank: null, avg30SalesRank: null, avg90SalesRank: null, rankRatioX100: null,
    reviewCount: null, averageRatingX10: null, lastRatingUpdate: null,
    monthlySold: null, keepaUpdatedAt: null, newOfferCount: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null,
    enrichmentStatus: null, inCatalog: false, fetched: false, lastFetchedAt: null, fetchCount: 0, inScope: false, bestRank: null, tier: 0,
    broadCategories,
  };
}

async function keywordSideTitle(run: SqlRunner, asin: string): Promise<string | null> {
  const q = productFallbackTitleSql(asin);
  const found = (await run(q.text, q.values)) as Array<{ title: string | null }>;
  return nonBlank(found[0]?.title);
}

/**
 * The facts for one ASIN: the primary-key read and the codes read, together (the codes come from
 * the reverse table whether or not the catalog has a row), plus the keyword-side title read only
 * when the row has no title. With no catalog row, one more read checks the reverse table: an ASIN
 * found there is a stub (`inCatalog: false`) that still carries its codes; null, which the page
 * answers with a 404, means neither table has the ASIN.
 */
export async function loadProduct(run: SqlRunner, asin: string): Promise<ProductFacts | null> {
  const facts = productFactsSql(asin);
  const codes = productBroadCategoriesSql(asin);
  const [rows, codeRows] = await Promise.all([
    run(facts.text, facts.values) as Promise<FactsRow[]>,
    run(codes.text, codes.values) as Promise<Array<{ broad_category: string }>>,
  ]);
  const broadCategories = codeRows.map((r) => r.broad_category);
  const row = rows[0];
  if (row) return toFacts(row, nonBlank(row.title) ?? (await keywordSideTitle(run, asin)), broadCategories);
  const tracked = productTrackedSql(asin);
  if (((await run(tracked.text, tracked.values)) as unknown[]).length === 0) return null;
  return untrackedStub(asin, await keywordSideTitle(run, asin), broadCategories);
}
