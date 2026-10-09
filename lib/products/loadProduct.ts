// lib/products/loadProduct.ts
/**
 * The ASIN page's facts card (spec 2026-10-09 §6.1): one catalog row by ASIN, plus a title from
 * the keyword side when the catalog has none (an ASIN the Keepa service has not fetched yet).
 *
 * The catalog KEEPS every fact on a delisted row (the service's delisted write leaves them in
 * place); this reader hides them, as mapEnrichedProducts (lib/explorer/fetchKeywordDetail.ts) does
 * for the keyword page: prices come through only for an `active` row, and a `delisted` row also
 * loses its point-in-time facts (sales rank, its averages and ratio, monthly sold, the offer
 * counts, Amazon availability). Title, brand, category, image, reviews, rating and the dates always
 * come through. Deliberately no in_scope or status predicate: a direct link opens out-of-scope and
 * delisted rows too.
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
  /** False until the service has fetched the ASIN once (last_fetched_at is null): the facts above are then all null. */
  fetched: boolean;
  /** ISO timestamp of the last fetch. */
  lastFetchedAt: string | null;
  fetchCount: number;
  inScope: boolean;
  /** The best (lowest) keyword rank among the keywords the ASIN was a top-3 clicked product for in the scope week; null when it has none. */
  bestRank: number | null;
  tier: number;
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
 * keyword tables, and keyword_current_summary holds the slot-1 title. Rows without a title are
 * skipped so LIMIT 1 cannot land on one when another keyword has it.
 */
export function productFallbackTitleSql(asin: string): SqlStatement {
  return {
    text: `SELECT kcs.top_clicked_product_1_title_current AS title
FROM keyword_top_asins k
JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id
WHERE k.asin = $1 AND k.slot = 1 AND kcs.top_clicked_product_1_title_current IS NOT NULL
LIMIT 1`,
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
/** neon hands back a timestamptz as a Date; a runner that returns text works too. */
const isoTimestamp = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

function toFacts(r: FactsRow, title: string | null): ProductFacts {
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
    fetched: lastFetchedAt !== null,
    lastFetchedAt: lastFetchedAt === null ? null : isoTimestamp(lastFetchedAt),
    fetchCount: r.fetch_count,
    inScope: r.in_scope,
    bestRank: r.best_rank ?? null,
    tier: r.tier,
  };
}

/**
 * The facts for one ASIN, or null when the catalog has no row (the page answers 404). One primary-key
 * read; the keyword-side title read happens only when the catalog row has no title.
 */
export async function loadProduct(run: SqlRunner, asin: string): Promise<ProductFacts | null> {
  const facts = productFactsSql(asin);
  const row = ((await run(facts.text, facts.values)) as FactsRow[])[0];
  if (!row) return null;
  let title = nonBlank(row.title);
  if (title === null) {
    const fallback = productFallbackTitleSql(asin);
    const found = (await run(fallback.text, fallback.values)) as Array<{ title: string | null }>;
    title = nonBlank(found[0]?.title);
  }
  return toFacts(row, title);
}
