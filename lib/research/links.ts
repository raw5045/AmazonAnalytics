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
