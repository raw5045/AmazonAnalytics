import 'server-only';
import { inArray, eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { searchTerms, watchlistItems } from '@/db/schema';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';
import { MAX_WATCHED_KEYWORDS } from './validation';
import { watchlistCountForUser } from './loadServer';

export interface BulkAddResult {
  added: number;
  alreadyWatching: number;
  unmatched: string[];
  skippedAtCap: number;
}

/**
 * Thrown when the helper rejects input before any DB work. The route
 * catches this and translates to 400. The helper validates as a
 * defensive safety net even though the route also validates up front.
 */
export class BulkAddInputError extends Error {
  constructor(public readonly code: 'too_many_keywords', message: string) {
    super(message);
    this.name = 'BulkAddInputError';
  }
}

const HARD_MAX_INPUT = 500;

/**
 * Add a paste-list of keywords to the user's watchlist in one shot.
 * See docs/superpowers/specs/2026-05-29-watchlist-bulk-add-design.md
 * §5 for the full server flow.
 *
 * - Matches input via the existing search_terms.search_term_normalized
 *   index (one round-trip).
 * - Idempotent: pasting the same list twice produces alreadyWatching=N
 *   on the second call, never duplicate rows (composite PK + ON CONFLICT).
 * - Best-effort cap: if remainingCap < toInsert.length, the first
 *   remainingCap matched keywords are added in input order; the rest
 *   are reported in skippedAtCap.
 */
export async function bulkAddToWatchlist(
  userId: string,
  inputKeywords: string[],
): Promise<BulkAddResult> {
  // 1. Validate input size as a defensive safety net.
  if (inputKeywords.length > HARD_MAX_INPUT) {
    throw new BulkAddInputError(
      'too_many_keywords',
      `at most ${HARD_MAX_INPUT} keywords allowed (got ${inputKeywords.length})`,
    );
  }

  // 2. Normalize + dedupe in input order. Keep the FIRST display form
  //    encountered per normalized key, so unmatched output shows the
  //    user's first spelling.
  const inputOrder: string[] = [];
  const displayByNormalized = new Map<string, string>();
  for (const raw of inputKeywords) {
    const normalized = normalizeForMatch(raw);
    if (!normalized) continue; // drops all-whitespace lines
    if (!displayByNormalized.has(normalized)) {
      displayByNormalized.set(normalized, raw.trim());
      inputOrder.push(normalized);
    }
  }

  // 3. Early exit on no usable input — no DB calls at all.
  if (inputOrder.length === 0) {
    return { added: 0, alreadyWatching: 0, unmatched: [], skippedAtCap: 0 };
  }

  // 4. Match against the search_terms catalog. One indexed lookup.
  const matchedRows = await db
    .select({
      id: searchTerms.id,
      normalized: searchTerms.searchTermNormalized,
    })
    .from(searchTerms)
    .where(inArray(searchTerms.searchTermNormalized, inputOrder));

  const keywordIdByNormalized = new Map<string, string>();
  for (const r of matchedRows) {
    keywordIdByNormalized.set(r.normalized, r.id);
  }

  // Build unmatched (display form) + matched-id list, both in input order.
  const unmatched: string[] = [];
  const matchedKeywordIdsInOrder: string[] = [];
  for (const normalized of inputOrder) {
    const id = keywordIdByNormalized.get(normalized);
    if (id) {
      matchedKeywordIdsInOrder.push(id);
    } else {
      unmatched.push(displayByNormalized.get(normalized) ?? normalized);
    }
  }

  // If nothing matched, there's no point hitting the rest of the DB.
  if (matchedKeywordIdsInOrder.length === 0) {
    return { added: 0, alreadyWatching: 0, unmatched, skippedAtCap: 0 };
  }

  // 5. Which of the matched ids are already watched by this user?
  const existingRows = await db
    .select({ keywordId: watchlistItems.keywordId })
    .from(watchlistItems)
    .where(
      and(
        eq(watchlistItems.userId, userId),
        inArray(watchlistItems.keywordId, matchedKeywordIdsInOrder),
      ),
    );
  const alreadyWatchingSet = new Set(existingRows.map((r) => r.keywordId));

  let alreadyWatchingCount = 0;
  let toInsert: string[] = [];
  for (const id of matchedKeywordIdsInOrder) {
    if (alreadyWatchingSet.has(id)) {
      alreadyWatchingCount += 1;
    } else {
      toInsert.push(id);
    }
  }

  // 6. Cap check. Best-effort: insert what fits in input order, report rest.
  let skippedAtCap = 0;
  if (toInsert.length > 0) {
    const currentCount = await watchlistCountForUser(userId);
    const remainingCap = Math.max(0, MAX_WATCHED_KEYWORDS - currentCount);
    if (toInsert.length > remainingCap) {
      skippedAtCap = toInsert.length - remainingCap;
      toInsert = toInsert.slice(0, remainingCap);
    }
  }

  // 7. Insert survivors. ON CONFLICT DO NOTHING handles the rare race
  //    where a parallel single-add lands between steps 5 and 7. We
  //    derive `added` from the actual returned rows, not toInsert.length.
  let added = 0;
  if (toInsert.length > 0) {
    const inserted = await db
      .insert(watchlistItems)
      .values(toInsert.map((keywordId) => ({ userId, keywordId })))
      .onConflictDoNothing()
      .returning({ k: watchlistItems.keywordId });
    added = inserted.length;
  }

  return {
    added,
    alreadyWatching: alreadyWatchingCount,
    unmatched,
    skippedAtCap,
  };
}
