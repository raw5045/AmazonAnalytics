// lib/keepa/productFacts.ts
/**
 * What one Keepa fetch yields for one ASIN, in the catalog's vocabulary (spec 2026-10-05 §4.1).
 * Produced by lib/keepa/parseProduct.ts, written by services/keepa/pgStore.ts.
 */
export type FactsStatus = 'active' | 'no_price' | 'delisted' | 'error';
export type PriceSource = 'amazon' | 'new';

export interface ProductFacts {
  asin: string;
  /** 'error' here means a bad product object (never a transport failure — those never reach the parser). */
  status: FactsStatus;
  errorCode: string | null;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  categoryPath: string | null;
  categoryRoot: string | null;
  categoryLeaf: string | null;
  /** ISO dates (YYYY-MM-DD). */
  listedSince: string | null;
  trackingSince: string | null;
  currentPriceCents: number | null;
  priceSource: PriceSource | null;
  salesRank: number | null;
  reviewCount: number | null;
  /** 0–50 scale. */
  averageRatingX10: number | null;
  lastRatingUpdate: string | null;
  /** Amazon's "bought in past month" floor; null without the badge. */
  monthlySold: number | null;
  /** Keepa's lastUpdate as an ISO date: the "as of" for monthly sold and offer counts. */
  keepaUpdatedAt: string | null;
  newOfferCount: number | null;
  fbaOfferCount: number | null;
  fbmOfferCount: number | null;
  /** Keepa code -1..4, see db/schema/asinProducts.ts. */
  amazonAvailability: number | null;
  avg30PriceCents: number | null;
  avg90PriceCents: number | null;
  avg180PriceCents: number | null;
  avg365PriceCents: number | null;
  avg30SalesRank: number | null;
  avg90SalesRank: number | null;
}

export function emptyFacts(asin: string, status: 'delisted' | 'error', errorCode: string | null = null): ProductFacts {
  return {
    asin,
    status,
    errorCode,
    title: null,
    brand: null,
    imageUrl: null,
    categoryPath: null,
    categoryRoot: null,
    categoryLeaf: null,
    listedSince: null,
    trackingSince: null,
    currentPriceCents: null,
    priceSource: null,
    salesRank: null,
    reviewCount: null,
    averageRatingX10: null,
    lastRatingUpdate: null,
    monthlySold: null,
    keepaUpdatedAt: null,
    newOfferCount: null,
    fbaOfferCount: null,
    fbmOfferCount: null,
    amazonAvailability: null,
    avg30PriceCents: null,
    avg90PriceCents: null,
    avg180PriceCents: null,
    avg365PriceCents: null,
    avg30SalesRank: null,
    avg90SalesRank: null,
  };
}
