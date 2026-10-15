/**
 * The enrichment outcome of a catalog row (mirrors the db enum asin_enrichment_status). The Keepa
 * service (services/keepa, lib/keepa/parseProduct.ts) writes it; the product pages read it. The old
 * import-time job's request/row types left with that job (arc 11).
 */
export type AsinEnrichmentStatus = 'active' | 'no_price' | 'delisted' | 'error';
