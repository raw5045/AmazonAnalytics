/**
 * Shared types for the Keepa client + parser.
 *
 * The Keepa /product response is intentionally loose — Keepa returns ~95
 * fields per product and we only extract a handful. We type just enough
 * to make the call envelope ergonomic; the inner `products[]` is left as
 * `unknown[]` so parseKeepaProduct can do its own narrowing.
 */

/** Top-level envelope of a Keepa /product response. */
export interface KeepaProductResponse {
  timestamp: number;
  tokensLeft: number;
  refillIn: number;
  refillRate: number;
  tokensConsumed?: number;
  processingTimeInMs?: number;
  products?: unknown[];
}

/** Enrichment outcome state machine. Mirrors db enum asin_enrichment_status. */
export type AsinEnrichmentStatus = 'active' | 'no_price' | 'delisted' | 'error';

/**
 * Domain model returned by parseKeepaProduct. Field names match
 * asin_weekly_data column names so the Inngest job can INSERT this
 * shape directly via drizzle's snake-case mapping.
 */
export interface EnrichmentRow {
  asin: string;
  week_end_date: string; // ISO date YYYY-MM-DD

  title: string | null;
  brand: string | null;
  image_url: string | null;

  category_path: string | null;
  category_root: string | null;
  category_leaf: string | null;

  current_price_cents: number | null;
  sales_rank: number | null;
  review_count: number | null;
  average_rating_x10: number | null;
  last_rating_update: string | null; // ISO date YYYY-MM-DD

  avg30_price_cents: number | null;
  avg90_price_cents: number | null;
  avg180_price_cents: number | null;
  avg365_price_cents: number | null;

  variations: unknown[] | null;
  promotions: unknown[] | null;

  enrichment_status: AsinEnrichmentStatus;
  error_message: string | null;
}
