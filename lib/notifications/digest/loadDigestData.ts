// lib/notifications/digest/loadDigestData.ts
import 'server-only';
import type { DigestKeywordRow } from './types';
import { and, eq, inArray, isNotNull, sql, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, watchlistItems, searchTerms, keywordCurrentSummary, keywordCurrentSummaryMeta, reportingWeeks, weeklyDigestRuns, weeklyDigestSends } from '@/db/schema';
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
 * selects the variant). When `onlyUnsentForWeek` is set, restrict to users
 * with a not-yet-sent send row (`status IN ('failed','pending')`) for that
 * week — used by resume/retry so both previously-failed and never-attempted
 * users are picked up.
 */
export async function loadEligibleRecipients(
  opts?: { onlyUnsentForWeek?: string },
): Promise<DigestRecipient[]> {
  const unsentSubquery = opts?.onlyUnsentForWeek
    ? inArray(
        users.id,
        db
          .select({ id: weeklyDigestSends.userId })
          .from(weeklyDigestSends)
          .where(
            and(
              eq(weeklyDigestSends.weekEndDate, opts.onlyUnsentForWeek),
              inArray(weeklyDigestSends.status, ['failed', 'pending']),
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
    .where(and(isNotNull(users.email), eq(users.weeklyDigestSubscribed, true), unsentSubquery))
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

/** A row for the /admin/digests table: a completed week + its digest run (if any). */
export interface DigestWeekRow {
  weekEndDate: string;
  isCurrent: boolean;
  runStatus: string | null;        // null = "Not sent"
  recipientsCount: number | null;
  sentCount: number | null;
  failedCount: number | null;
}

/**
 * Recent completed weeks joined to their digest run, plus which week is
 * the current snapshot (the only sendable one).
 */
export async function loadDigestWeeks(limit = 12): Promise<DigestWeekRow[]> {
  const [meta] = await db
    .select({ current: keywordCurrentSummaryMeta.currentWeekEndDate })
    .from(keywordCurrentSummaryMeta)
    .limit(1);
  const currentWeek = meta?.current ?? null;

  const weeks = await db
    .select({
      weekEndDate: reportingWeeks.weekEndDate,
      runStatus: weeklyDigestRuns.status,
      recipientsCount: weeklyDigestRuns.recipientsCount,
      sentCount: weeklyDigestRuns.sentCount,
      failedCount: weeklyDigestRuns.failedCount,
    })
    .from(reportingWeeks)
    .leftJoin(weeklyDigestRuns, eq(weeklyDigestRuns.weekEndDate, reportingWeeks.weekEndDate))
    .where(eq(reportingWeeks.isComplete, true))
    .orderBy(desc(reportingWeeks.weekEndDate))
    .limit(limit);

  return weeks.map((w) => ({
    weekEndDate: w.weekEndDate,
    isCurrent: w.weekEndDate === currentWeek,
    runStatus: w.runStatus ?? null,
    recipientsCount: w.recipientsCount ?? null,
    sentCount: w.sentCount ?? null,
    failedCount: w.failedCount ?? null,
  }));
}

/** The current snapshot week (the only sendable one), or null. */
export async function getCurrentDigestWeek(): Promise<string | null> {
  const [meta] = await db
    .select({ current: keywordCurrentSummaryMeta.currentWeekEndDate })
    .from(keywordCurrentSummaryMeta)
    .limit(1);
  return meta?.current ?? null;
}

/**
 * Count of users who would receive a fresh digest send (subscribed +
 * have an email). Used by the admin page to show the blast radius in the
 * Send confirm dialog. (A retry targets a subset; this is the upper bound.)
 */
export async function countSubscribedRecipients(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(users)
    .where(and(isNotNull(users.email), eq(users.weeklyDigestSubscribed, true)));
  return row?.n ?? 0;
}
