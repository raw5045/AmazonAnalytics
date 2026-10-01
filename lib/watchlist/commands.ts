/**
 * Shared watchlist commands (spec 2026-09-30 §6.3), by keyword text and/or search-term id.
 * The paste box's `bulkAddToWatchlist` (./bulkAdd.ts) is now a wrapper over `addToWatchlist`.
 * Neither command fails on user input: unmatched text and unknown ids come back verbatim in
 * `unmatched`, the cap is best-effort in input order, removal is owner-scoped and idempotent.
 */
import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { searchTerms, watchlistItems } from '@/db/schema';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';
import { MAX_WATCHED_KEYWORDS, isValidUuid } from './validation';
import { watchlistCountForUser } from './loadServer';

export interface WatchlistSelection {
  keywords: string[];
  searchTermIds: string[];
}
export interface AddToWatchlistResult {
  added: number;
  alreadyWatching: number;
  /** Text that matched no keyword, and ids that exist nowhere, in the caller's own spelling and order. */
  unmatched: string[];
  skippedAtCap: number;
}
export interface RemoveFromWatchlistResult {
  removed: number;
  notWatching: number;
  unmatched: string[];
}

/** Text → ids via the normalized index (one lookup), ids → existence check (one lookup); distinct, input order, text first. */
async function resolveSelection(sel: WatchlistSelection): Promise<{ ids: string[]; unmatched: string[] }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  const inputOrder: string[] = [];
  const displayByNormalized = new Map<string, string>();
  for (const raw of sel.keywords) {
    const normalized = normalizeForMatch(raw);
    if (!normalized) continue; // whitespace-only
    if (!displayByNormalized.has(normalized)) {
      displayByNormalized.set(normalized, raw.trim());
      inputOrder.push(normalized);
    }
  }
  if (inputOrder.length > 0) {
    const rows = await db
      .select({ id: searchTerms.id, normalized: searchTerms.searchTermNormalized })
      .from(searchTerms)
      .where(inArray(searchTerms.searchTermNormalized, inputOrder));
    const idByNormalized = new Map(rows.map((r) => [r.normalized, r.id]));
    for (const normalized of inputOrder) {
      const id = idByNormalized.get(normalized);
      if (!id) unmatched.push(displayByNormalized.get(normalized) ?? normalized);
      else if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  const wanted: string[] = [];
  for (const raw of sel.searchTermIds) {
    if (!isValidUuid(raw)) unmatched.push(raw);
    else if (!wanted.includes(raw)) wanted.push(raw);
  }
  if (wanted.length > 0) {
    const rows = await db.select({ id: searchTerms.id }).from(searchTerms).where(inArray(searchTerms.id, wanted));
    const found = new Set(rows.map((r) => r.id));
    for (const id of wanted) {
      if (!found.has(id)) unmatched.push(id);
      else if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  return { ids, unmatched };
}

export async function addToWatchlist(userId: string, sel: WatchlistSelection): Promise<AddToWatchlistResult> {
  const { ids, unmatched } = await resolveSelection(sel);
  if (ids.length === 0) return { added: 0, alreadyWatching: 0, unmatched, skippedAtCap: 0 };
  const existing = await db
    .select({ keywordId: watchlistItems.keywordId })
    .from(watchlistItems)
    .where(and(eq(watchlistItems.userId, userId), inArray(watchlistItems.keywordId, ids)));
  const already = new Set(existing.map((r) => r.keywordId));
  let toInsert = ids.filter((id) => !already.has(id));
  const alreadyWatching = ids.length - toInsert.length;
  let skippedAtCap = 0;
  if (toInsert.length > 0) {
    // Best-effort cap: insert what fits in input order, report the rest (spec §8.7 accepts the race).
    const remaining = Math.max(0, MAX_WATCHED_KEYWORDS - (await watchlistCountForUser(userId)));
    if (toInsert.length > remaining) {
      skippedAtCap = toInsert.length - remaining;
      toInsert = toInsert.slice(0, remaining);
    }
  }
  let added = 0;
  if (toInsert.length > 0) {
    const inserted = await db
      .insert(watchlistItems)
      .values(toInsert.map((keywordId) => ({ userId, keywordId })))
      .onConflictDoNothing()
      .returning({ k: watchlistItems.keywordId });
    added = inserted.length;
  }
  return { added, alreadyWatching, unmatched, skippedAtCap };
}

export async function removeFromWatchlist(userId: string, sel: WatchlistSelection): Promise<RemoveFromWatchlistResult> {
  const { ids, unmatched } = await resolveSelection(sel);
  if (ids.length === 0) return { removed: 0, notWatching: 0, unmatched };
  const deleted = await db
    .delete(watchlistItems)
    .where(and(eq(watchlistItems.userId, userId), inArray(watchlistItems.keywordId, ids)))
    .returning({ k: watchlistItems.keywordId });
  return { removed: deleted.length, notWatching: ids.length - deleted.length, unmatched };
}
