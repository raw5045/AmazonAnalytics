export const MAX_WATCHED_KEYWORDS = 100;

/**
 * Server-side cap on a single bulk-add request's input size. 5x the
 * watchlist cap — generous but prevents pathological payloads.
 *
 * Lives here (not in bulkAdd.ts) so the client-side BulkAddSection can
 * reference it in its error copy without pulling a 'server-only' module
 * into the client bundle.
 */
export const HARD_MAX_INPUT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
