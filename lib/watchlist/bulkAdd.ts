import 'server-only';
import { HARD_MAX_INPUT } from './validation';
import { addToWatchlist, type AddToWatchlistResult } from './commands';

/** Kept for the paste-box route and its tests; identical to AddToWatchlistResult. */
export type BulkAddResult = AddToWatchlistResult;

/**
 * Thrown when the helper rejects input before any DB work. The route
 * catches this and translates to 400.
 */
export class BulkAddInputError extends Error {
  constructor(public readonly code: 'too_many_keywords', message: string) {
    super(message);
    this.name = 'BulkAddInputError';
  }
}

/**
 * Add a paste-list of keywords to the user's watchlist in one shot — a wrapper over
 * lib/watchlist/commands.ts's addToWatchlist since arc 3 (spec 2026-09-30 §6.3). Same
 * contract as before: idempotent, best-effort cap in input order, unmatched in the user's
 * first spelling, and at most HARD_MAX_INPUT inputs. See
 * docs/superpowers/specs/2026-05-29-watchlist-bulk-add-design.md §5 for the original flow.
 */
export async function bulkAddToWatchlist(userId: string, inputKeywords: string[]): Promise<BulkAddResult> {
  if (inputKeywords.length > HARD_MAX_INPUT) {
    throw new BulkAddInputError('too_many_keywords', `at most ${HARD_MAX_INPUT} keywords allowed (got ${inputKeywords.length})`);
  }
  return addToWatchlist(userId, { keywords: inputKeywords, searchTermIds: [] });
}
