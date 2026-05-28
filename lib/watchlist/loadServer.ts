import 'server-only';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { watchlistItems } from '@/db/schema';
import type { WatchlistItem } from './types';

/**
 * Server-only helpers for loading a user's watchlist during page
 * render. Assumes the caller has already authenticated the user.
 */

/** Return all watchlist items for `userId`, newest-added first. */
export async function listWatchlistForUser(userId: string): Promise<WatchlistItem[]> {
  const rows = await db
    .select({ keywordId: watchlistItems.keywordId, addedAt: watchlistItems.addedAt })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, userId))
    .orderBy(desc(watchlistItems.addedAt));
  return rows.map((r) => ({
    keywordId: r.keywordId,
    addedAt: r.addedAt.toISOString(),
  }));
}

/** Count helper for the tab-nav badge. Cheaper than listing. */
export async function watchlistCountForUser(userId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, userId));
  return n;
}

/** Used by the detail page to set initial isWatched state. */
export async function isKeywordWatched(userId: string, keywordId: string): Promise<boolean> {
  const [row] = await db
    .select({ k: watchlistItems.keywordId })
    .from(watchlistItems)
    .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.keywordId, keywordId)))
    .limit(1);
  return Boolean(row);
}
