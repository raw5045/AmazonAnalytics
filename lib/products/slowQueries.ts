// lib/products/slowQueries.ts
/**
 * Records a product search that ran long (spec 2026-10-23 §5b): the Products list calls it after the search
 * settled, fire-and-forget, so recording never delays or fails the response. One row per timeout (the 30 s
 * statement cap, SQLSTATE 57014) or per completed search slower than SLOW_PRODUCT_SEARCH_MS, carrying the
 * filter combination as the URL query string. The daily usage digest reads the rows; the integration harness
 * replays a query string. A failed insert warns once with coded fields and is otherwise silent.
 */
import { db } from '@/db/client';
import { slowQueries } from '@/db/schema';
import { errFields } from '@/lib/ask/logSafe';

/** A product search slower than this is recorded even when it completes. */
export const SLOW_PRODUCT_SEARCH_MS = 8_000;

export interface SlowProductSearch { userId: string | null; queryString: string; elapsedMs: number; timedOut: boolean }

export async function recordSlowProductSearch(args: SlowProductSearch): Promise<void> {
  try {
    await db.insert(slowQueries).values({
      surface: 'products',
      userId: args.userId,
      queryString: args.queryString,
      elapsedMs: Math.round(args.elapsedMs),
      timedOut: args.timedOut,
    });
  } catch (e) {
    // Coded fields only: a DrizzleQueryError's own message embeds the statement and its params.
    const { error, code } = errFields(e);
    console.warn('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', error, code }));
  }
}
