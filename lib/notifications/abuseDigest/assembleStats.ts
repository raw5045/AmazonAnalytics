// lib/notifications/abuseDigest/assembleStats.ts
// Pure merge of the loader's raw query outputs into PerUserActivity rows.
// Split out from loadAbuseDigestData so it can be unit-tested without a DB.
import type { UserActivityMetric } from '@/lib/activity/bump';
import type { PerUserActivity } from './types';

export interface CounterRow {
  userId: string;
  metric: string;
  count: number;
}

export interface CreationCounts {
  watchlistAdds: Map<string, number>;
  savedViewsCreated: Map<string, number>;
  customCategoriesCreated: Map<string, number>;
}

export interface UserInfo {
  email: string;
  name: string | null;
}

// Compile-time tether to the writer's metric names (lib/activity/bump.ts) —
// a rename on either side becomes a type error instead of silently rendering
// users as active-with-zero-reads.
const USER_METRICS = {
  explorerQuery: 'explorer_query',
  detailView: 'detail_view',
} satisfies Record<string, UserActivityMetric>;

/**
 * One row per user that has ANY counter or creation for the day, sorted by
 * reads (explorer queries + detail views) desc. Unknown metric names are
 * ignored (forward-compat if a future metric ships before the digest knows
 * how to display it).
 */
export function assemblePerUserActivity(
  counters: CounterRow[],
  creations: CreationCounts,
  userInfo: Map<string, UserInfo>,
): PerUserActivity[] {
  const byUser = new Map<string, PerUserActivity>();

  const rowFor = (userId: string): PerUserActivity => {
    let row = byUser.get(userId);
    if (!row) {
      const info = userInfo.get(userId);
      row = {
        userId,
        email: info?.email ?? '(unknown user)',
        name: info?.name ?? null,
        explorerQueries: 0,
        detailViews: 0,
        watchlistAdds: 0,
        savedViewsCreated: 0,
        customCategoriesCreated: 0,
      };
      byUser.set(userId, row);
    }
    return row;
  };

  for (const c of counters) {
    const row = rowFor(c.userId);
    if (c.metric === USER_METRICS.explorerQuery) row.explorerQueries = c.count;
    else if (c.metric === USER_METRICS.detailView) row.detailViews = c.count;
    // unknown metrics: row still marks the user active, but no column moves
  }
  for (const [userId, n] of creations.watchlistAdds) rowFor(userId).watchlistAdds = n;
  for (const [userId, n] of creations.savedViewsCreated) rowFor(userId).savedViewsCreated = n;
  for (const [userId, n] of creations.customCategoriesCreated) rowFor(userId).customCategoriesCreated = n;

  return [...byUser.values()].sort(
    (a, b) => b.explorerQueries + b.detailViews - (a.explorerQueries + a.detailViews),
  );
}
