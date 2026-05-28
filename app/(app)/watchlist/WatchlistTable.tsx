'use client';

import { useMemo, useState } from 'react';
import { ResultsTable } from '@/app/(app)/explorer/ResultsTable';
import type { ExplorerRow, MatchMode, SortKey, WindowKey } from '@/lib/explorer/types';

/**
 * Client wrapper for the watchlist page's ResultsTable. Tracks which
 * rows the user has un-starred in this session (`removedKeywordIds`)
 * and derives the visible rows from fresh server props minus those
 * removals.
 *
 * Why a derived view instead of useState(initialRows)?
 *   When the user changes the window or sort, WindowSelector/Sortable-
 *   Header calls router.replace/push and the server component re-renders
 *   with fresh initialRows. useState only seeds from props on mount, so
 *   holding the rows in state would show stale data. The Set of
 *   removed-IDs is the small piece of true client-only state.
 *
 * router.refresh() is handled inside WatchStar after a successful
 * toggle (updates the tab-nav count badge). We deliberately do NOT
 * refresh again here — that would double the RSC payload fetch +
 * SQL projection per click.
 */
export function WatchlistTable({
  initialRows,
  window,
  matchMode,
  currentSort,
  initialAddedAtByKeyword,
}: {
  initialRows: ExplorerRow[];
  window: WindowKey;
  matchMode: MatchMode;
  currentSort: SortKey;
  /**
   * Map serialized as [k, v] tuples for server→client transfer.
   * Native Map isn't a Server Component props-serializable type.
   */
  initialAddedAtByKeyword: Array<[string, string]>;
}) {
  const [removedKeywordIds, setRemovedKeywordIds] = useState<Set<string>>(
    () => new Set(),
  );

  const visibleRows = useMemo(
    () => initialRows.filter((r) => !removedKeywordIds.has(r.searchTermId)),
    [initialRows, removedKeywordIds],
  );

  // The watched set is exactly the set of visible rows (every row on
  // /watchlist is by definition watched until the user un-stars it).
  const watchedKeywordIds = useMemo(
    () => new Set(visibleRows.map((r) => r.searchTermId)),
    [visibleRows],
  );

  const addedAtByKeyword = useMemo(
    () => new Map(initialAddedAtByKeyword),
    [initialAddedAtByKeyword],
  );

  return (
    <ResultsTable
      rows={visibleRows}
      window={window}
      matchMode={matchMode}
      currentSort={currentSort}
      backUrl="/watchlist"
      watchedKeywordIds={watchedKeywordIds}
      showWatchColumn
      addedAtByKeyword={addedAtByKeyword}
      onWatchStarToggle={(keywordId, isNowWatched) => {
        if (!isNowWatched) {
          setRemovedKeywordIds((prev) => {
            const next = new Set(prev);
            next.add(keywordId);
            return next;
          });
        }
        // Note: WatchStar already calls router.refresh() on success;
        // no need to duplicate here.
      }}
    />
  );
}
