'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ResultsTable } from '@/app/(app)/explorer/ResultsTable';
import type { ExplorerRow, MatchMode, SortKey, WindowKey } from '@/lib/explorer/types';

/**
 * Client wrapper for the watchlist page's ResultsTable. Owns the rows
 * array as state so a successful un-watch removes the row instantly
 * (instead of waiting for router.refresh() to refetch and re-render).
 *
 * On any toggle, we also router.refresh() in the background so the
 * tab-nav count badge updates server-side.
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
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const addedAtByKeyword = new Map(initialAddedAtByKeyword);
  // Initially everything in rows is watched (this IS the watchlist!).
  const [watchedKeywordIds, setWatchedKeywordIds] = useState(
    () => new Set(initialRows.map((r) => r.searchTermId)),
  );

  return (
    <ResultsTable
      rows={rows}
      window={window}
      matchMode={matchMode}
      currentSort={currentSort}
      backUrl="/watchlist"
      watchedKeywordIds={watchedKeywordIds}
      showWatchColumn
      addedAtByKeyword={addedAtByKeyword}
      onWatchStarToggle={(keywordId, isNowWatched) => {
        if (!isNowWatched) {
          setRows((prev) => prev.filter((r) => r.searchTermId !== keywordId));
          setWatchedKeywordIds((prev) => {
            const next = new Set(prev);
            next.delete(keywordId);
            return next;
          });
        }
        router.refresh();
      }}
    />
  );
}
