// lib/notifications/digest/loadDigestData.ts
import 'server-only';
import type { DigestKeywordRow } from './types';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, watchlistItems, searchTerms, keywordCurrentSummary, weeklyDigestSends } from '@/db/schema';
import type { DigestRecipient } from './types';

/** Raw shape returned by the watchlist-rows query (pre-grouping). */
export interface RawWatchlistRow extends DigestKeywordRow {
  userId: string;
}

/**
 * Group raw (user, keyword) rows by user and sort each user's list
 * biggest-mover-first: |improvement1w| desc, nulls last, ties broken by
 * current rank asc. Pure — unit tested directly.
 */
export function groupAndSortWatchlistRows(
  rows: RawWatchlistRow[],
): Map<string, DigestKeywordRow[]> {
  const byUser = new Map<string, DigestKeywordRow[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({
      searchTermId: r.searchTermId,
      searchTermRaw: r.searchTermRaw,
      currentRank: r.currentRank,
      priorWeekRank: r.priorWeekRank,
      rank4wAgo: r.rank4wAgo,
      improvement1w: r.improvement1w,
      estMonthlyVolume: r.estMonthlyVolume,
    });
    byUser.set(r.userId, list);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => {
      const aNull = a.improvement1w === null;
      const bNull = b.improvement1w === null;
      if (aNull && bNull) return rankAsc(a, b);
      if (aNull) return 1;   // nulls last
      if (bNull) return -1;
      const diff = Math.abs(b.improvement1w as number) - Math.abs(a.improvement1w as number);
      if (diff !== 0) return diff;
      return rankAsc(a, b);
    });
  }
  return byUser;
}

function rankAsc(a: DigestKeywordRow, b: DigestKeywordRow): number {
  const ar = a.currentRank ?? Number.POSITIVE_INFINITY;
  const br = b.currentRank ?? Number.POSITIVE_INFINITY;
  return ar - br;
}

/**
 * All subscribed users with an email, plus their watchlist count (which
 * selects the variant). When `onlyFailedForWeek` is set, restrict to
 * users with a failed send row for that week (retry mode).
 */
export async function loadEligibleRecipients(
  opts?: { onlyFailedForWeek?: string },
): Promise<DigestRecipient[]> {
  const failedSubquery = opts?.onlyFailedForWeek
    ? inArray(
        users.id,
        db
          .select({ id: weeklyDigestSends.userId })
          .from(weeklyDigestSends)
          .where(
            and(
              eq(weeklyDigestSends.weekEndDate, opts.onlyFailedForWeek),
              eq(weeklyDigestSends.status, 'failed'),
            ),
          ),
      )
    : undefined;

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      watchlistCount: sql<number>`COUNT(${watchlistItems.keywordId})::int`,
    })
    .from(users)
    .leftJoin(watchlistItems, eq(watchlistItems.userId, users.id))
    .where(and(isNotNull(users.email), eq(users.weeklyDigestSubscribed, true), failedSubquery))
    .groupBy(users.id, users.email);

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    watchlistCount: r.watchlistCount,
  }));
}

/**
 * Current-week metrics for every keyword watched by the given users,
 * grouped per user and sorted biggest-mover-first. LEFT JOIN to kcs so a
 * keyword that fell out of this week's rankings still returns (with null
 * metrics → "not ranked this week" in the email).
 */
export async function loadWatchlistRowsByUser(
  userIds: string[],
): Promise<Map<string, DigestKeywordRow[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: watchlistItems.userId,
      searchTermId: searchTerms.id,
      searchTermRaw: searchTerms.searchTermRaw,
      currentRank: keywordCurrentSummary.currentRank,
      priorWeekRank: keywordCurrentSummary.priorWeekRank,
      rank4wAgo: keywordCurrentSummary.rank4wAgo,
      improvement1w: keywordCurrentSummary.improvement1w,
      estMonthlyVolume: keywordCurrentSummary.estimatedMonthlyVolumeCurrent,
    })
    .from(watchlistItems)
    .innerJoin(searchTerms, eq(searchTerms.id, watchlistItems.keywordId))
    .leftJoin(keywordCurrentSummary, eq(keywordCurrentSummary.searchTermId, watchlistItems.keywordId))
    .where(inArray(watchlistItems.userId, userIds));

  return groupAndSortWatchlistRows(rows as RawWatchlistRow[]);
}
