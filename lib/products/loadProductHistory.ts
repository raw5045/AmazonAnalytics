// lib/products/loadProductHistory.ts
/**
 * The ASIN page's history charts (spec 2026-10-09 §6.2): one narrow asin_snapshots row per Keepa
 * fetch, the newest 400 of them, returned oldest first for the charts. The table's primary key is
 * (asin, fetched_at), so the read is an index range scan. A delisted or no_price fetch writes a
 * snapshot with the facts it could not read left null, so the points carry no stale values and
 * each one's status says why a gap is a gap.
 */
import type { AsinEnrichmentStatus } from '@/db/schema';
import type { SqlRunner, SqlStatement } from './searchProducts';

export const PRODUCT_HISTORY_CAP = 400;

export interface HistoryPoint {
  /** ISO timestamp of the Keepa fetch. */
  fetchedAt: string;
  currentPriceCents: number | null;
  salesRank: number | null;
  reviewCount: number | null;
  /** 0–50 scale (divide by 10 for stars). */
  averageRatingX10: number | null;
  monthlySold: number | null;
  newOfferCount: number | null;
  fbaOfferCount: number | null;
  fbmOfferCount: number | null;
  enrichmentStatus: AsinEnrichmentStatus;
}

/** The newest `cap` snapshots of the ASIN, newest first (so the cap keeps the newest points). */
export function productHistorySql(asin: string, cap: number): SqlStatement {
  return {
    text: `SELECT s.fetched_at, s.current_price_cents, s.sales_rank, s.review_count, s.average_rating_x10,
  s.monthly_sold, s.new_offer_count, s.fba_offer_count, s.fbm_offer_count, s.enrichment_status::text AS enrichment_status
FROM asin_snapshots s
WHERE s.asin = $1
ORDER BY s.fetched_at DESC
LIMIT $2`,
    values: [asin, cap],
  };
}

interface SnapshotRow {
  fetched_at: Date | string;
  current_price_cents: number | null;
  sales_rank: number | null;
  review_count: number | null;
  average_rating_x10: number | null;
  monthly_sold: number | null;
  new_offer_count: number | null;
  fba_offer_count: number | null;
  fbm_offer_count: number | null;
  enrichment_status: AsinEnrichmentStatus;
}

/** neon hands back a timestamptz as a Date; a runner that returns text works too. */
const isoTimestamp = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

function toPoint(r: SnapshotRow): HistoryPoint {
  return {
    fetchedAt: isoTimestamp(r.fetched_at),
    currentPriceCents: r.current_price_cents ?? null,
    salesRank: r.sales_rank ?? null,
    reviewCount: r.review_count ?? null,
    averageRatingX10: r.average_rating_x10 ?? null,
    monthlySold: r.monthly_sold ?? null,
    newOfferCount: r.new_offer_count ?? null,
    fbaOfferCount: r.fba_offer_count ?? null,
    fbmOfferCount: r.fbm_offer_count ?? null,
    enrichmentStatus: r.enrichment_status,
  };
}

/** Up to the newest 400 snapshots of the ASIN, oldest first. Empty for an ASIN with no snapshots. */
export async function loadProductHistory(run: SqlRunner, asin: string): Promise<HistoryPoint[]> {
  const q = productHistorySql(asin, PRODUCT_HISTORY_CAP);
  const rows = (await run(q.text, q.values)) as SnapshotRow[];
  return rows.map(toPoint).reverse();
}
