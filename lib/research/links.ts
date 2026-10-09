/**
 * URL builders shared across the research MCP tools' response rows.
 */

/**
 * The Explorer detail-page URL for one keyword. `appUrl` is the deployment's own base URL
 * (trailing slashes stripped, however many); `searchTermId` is inserted verbatim. Shared by
 * query.ts's `mapSearchRow` (search_keywords rows) and details.ts's `loadKeywordDetails`
 * (get_keyword_details), so both tools link to the exact same path.
 */
export function keywordUrlFor(appUrl: string, searchTermId: string): string {
  return `${appUrl.replace(/\/+$/, '')}/explorer/keyword/${searchTermId}`;
}

/**
 * The ASIN page URL for one product (the admin-only Products pages, spec 2026-10-09 §6).
 * `appUrl` loses its trailing slashes exactly as keywordUrlFor's does; `asin` is inserted
 * verbatim (the products tools only ever pass a schema-validated ASIN). Shared by
 * search_products' rows and get_product_details' product (lib/research/products.ts).
 */
export function productUrlFor(appUrl: string, asin: string): string {
  return `${appUrl.replace(/\/+$/, '')}/products/${asin}`;
}
