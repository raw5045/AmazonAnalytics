// lib/products/slowQueries.ts
/**
 * Records a product search that ran long (spec 2026-10-23 §5b): the Products list (surface 'products') and the
 * search_products tool (surface 'products_tool': an AI client over the MCP, or Ask AI; lib/research/products.ts) hand
 * the row to scheduleSlowSearchRecord once the search settled, so recording never delays or fails the response. One row
 * per timeout (the 30 s statement cap, SQLSTATE 57014) or per completed search slower than SLOW_PRODUCT_SEARCH_MS,
 * carrying the filter combination as the URL query string (the tool's carries its category scope too: its taxonomy
 * selections as `leaf` and its custom ids as `custom`, the page's own forms, and its exact leaf paths, which the page has
 * no form for, as a replay-only `leafExact`; toolQueryString in lib/research/products.ts). The daily usage digest reads
 * the rows. A recorded query string can be replayed by hand in tests/integration/productsQueries.test.ts
 * (PRODUCTS_REPLAY_QUERY=<query string>, or PRODUCTS_REPLAY_FILE=<path>; lib/products/replayQuery.ts reads it); nothing
 * replays one automatically. A string longer than QUERY_STRING_MAX_CHARS is stored cut, with a marker. A failed insert
 * warns once with coded fields and is otherwise silent.
 */
import { after } from 'next/server';
import { db } from '@/db/client';
import { slowQueries } from '@/db/schema';
import { errFields } from '@/lib/ask/logSafe';

/** A product search slower than this is recorded even when it completes. */
export const SLOW_PRODUCT_SEARCH_MS = 8_000;

/**
 * The longest query string stored, marker aside: a safety bound above what the search_products tool records in practice
 * (up to 2,000 exact catalog paths of up to 256 characters, URL-encoded: under 1 MB); the page's strings are URL-bounded.
 * Postgres keeps a long value out of line (TOAST), the digest job's 90-day prune removes it, and the digest shows 400
 * characters of it. A Windows environment variable holds at most 32,767 characters, so a longer string's replay reads it
 * from a file (PRODUCTS_REPLAY_FILE).
 */
export const QUERY_STRING_MAX_CHARS = 1_000_000;

/**
 * `s` whole up to QUERY_STRING_MAX_CHARS characters, else its first QUERY_STRING_MAX_CHARS followed by ` ...[+N chars]`
 * (N = the characters dropped): the replay (parseRecordedProductSearch, lib/products/replayQuery.ts) sees the marker and
 * refuses the string, whose scope is partial. A query string is URL-encoded, so ASCII: no surrogate pair to split.
 */
function capQueryString(s: string): string {
  return s.length <= QUERY_STRING_MAX_CHARS ? s : `${s.slice(0, QUERY_STRING_MAX_CHARS)} ...[+${s.length - QUERY_STRING_MAX_CHARS} chars]`;
}

/** Where a recorded search ran: the Products list, or the search_products tool (an AI client over the MCP, or Ask AI). */
export type SlowQuerySurface = 'products' | 'products_tool';

export interface SlowProductSearch {
  userId: string | null;
  queryString: string;
  elapsedMs: number;
  timedOut: boolean;
  /** Stored as given; absent is the Products list's 'products'. */
  surface?: SlowQuerySurface;
}

export async function recordSlowProductSearch(args: SlowProductSearch): Promise<void> {
  const surface = args.surface ?? 'products';
  try {
    await db.insert(slowQueries).values({
      surface,
      userId: args.userId,
      queryString: capQueryString(args.queryString),
      elapsedMs: Math.round(args.elapsedMs),
      timedOut: args.timedOut,
    });
  } catch (e) {
    // Coded fields only: a DrizzleQueryError's own message embeds the statement and its params.
    const { error, code } = errFields(e);
    console.warn('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', surface, error, code }));
  }
}

/**
 * Hands one slow-search row to after() (spec 2026-10-23 §5b), for both surfaces: Next runs the insert once the response
 * has finished and keeps the function alive until it lands (waitUntil), so a response that ends first cannot drop it.
 * after() throws synchronously outside a request scope (tests and scripts, and wherever a call runs without one); the row
 * is then recorded directly, still never awaited. Either way the caller's response is unchanged, and a failed insert only
 * warns.
 */
export function scheduleSlowSearchRecord(row: SlowProductSearch): void {
  try {
    after(() => recordSlowProductSearch(row));
  } catch {
    void recordSlowProductSearch(row);
  }
}
