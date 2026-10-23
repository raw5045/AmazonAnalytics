// lib/products/slowQueries.ts
/**
 * Records a product search that ran long (spec 2026-10-23 §5b): the Products list (surface 'products') and the
 * search_products tool (surface 'products_tool': an AI client over the MCP, or Ask AI; lib/research/products.ts) call
 * it after the search settled, fire-and-forget, so recording never delays or fails the response. One row per timeout
 * (the 30 s statement cap, SQLSTATE 57014) or per completed search slower than SLOW_PRODUCT_SEARCH_MS, carrying the
 * filter combination as the URL query string (the tool's carries its category scope too: its taxonomy selections as
 * `leaf` and its custom ids as `custom`, the page's own forms, and its exact leaf paths, which the page has no form for,
 * as a replay-only `leafExact`; toolQueryString in lib/research/products.ts). The daily usage digest reads the rows. A
 * recorded query string can be replayed by hand in tests/integration/productsQueries.test.ts
 * (PRODUCTS_REPLAY_QUERY=<query string>, or PRODUCTS_REPLAY_FILE=<path>); nothing replays one automatically. A string
 * longer than QUERY_STRING_MAX_CHARS is stored cut, with a marker. A failed insert warns once with coded fields and is
 * otherwise silent.
 */
import { db } from '@/db/client';
import { slowQueries } from '@/db/schema';
import { errFields } from '@/lib/ask/logSafe';

/** A product search slower than this is recorded even when it completes. */
export const SLOW_PRODUCT_SEARCH_MS = 8_000;

/**
 * The longest query string stored, marker aside: just under the 32,767-character limit of a Windows environment variable,
 * which the replay's PRODUCTS_REPLAY_QUERY runs through. The page's strings are URL-bounded and never reach it; the
 * search_products tool's can (up to 25 selections and 2,000 exact paths).
 */
export const QUERY_STRING_MAX_CHARS = 32_000;

/**
 * `s` whole up to QUERY_STRING_MAX_CHARS characters, else its first QUERY_STRING_MAX_CHARS followed by ` ...[+N chars]`
 * (N = the characters dropped), so a reader of the stored row (the replay prints it whole) sees that it was cut. A query
 * string is URL-encoded, so ASCII: no surrogate pair to split.
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
  try {
    await db.insert(slowQueries).values({
      surface: args.surface ?? 'products',
      userId: args.userId,
      queryString: capQueryString(args.queryString),
      elapsedMs: Math.round(args.elapsedMs),
      timedOut: args.timedOut,
    });
  } catch (e) {
    // Coded fields only: a DrizzleQueryError's own message embeds the statement and its params.
    const { error, code } = errFields(e);
    console.warn('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', error, code }));
  }
}
