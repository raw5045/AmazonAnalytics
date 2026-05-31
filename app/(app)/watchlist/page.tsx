/**
 * /watchlist — Plan 3.4.2 watchlist page.
 *
 * Server component that:
 *   1. Loads the user's watchlist items (already auth-guarded by the
 *      parent (app) layout)
 *   2. Loads explorer-row data for those IDs via fetchExplorerRowsByIds
 *   3. Renders <WatchlistTable> (a client wrapper around ResultsTable
 *      that owns row state) + the small window selector at top
 *
 * The client wrapper handles row-removal-on-unwatch locally so clicks
 * don't require a full server round-trip to update the visible rows.
 */
import type { Metadata } from 'next';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { listWatchlistForUser } from '@/lib/watchlist/loadServer';
import { fetchExplorerRowsByIds } from '@/lib/explorer/fetchExplorerRowsByIds';
import { parseExplorerFilters, type SearchParamsLike } from '@/lib/explorer/parseFilters';
import { MAX_WATCHED_KEYWORDS } from '@/lib/watchlist/validation';
import { WatchlistTable } from './WatchlistTable';
import { WindowSelector } from './WindowSelector';
import { BulkAddSection } from './BulkAddSection';

export const metadata: Metadata = { title: 'Watchlist' };

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
  const user = await requireAuthenticatedUser();
  const filters = parseExplorerFilters(sp);  // we use `window`, `sort`, `matchMode`

  const items = await listWatchlistForUser(user.id);
  if (items.length === 0) {
    return (
      <div className="p-6">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Watchlist</h1>
          <p className="text-sm text-gray-600">
            0 of {MAX_WATCHED_KEYWORDS} keywords watched
          </p>
        </header>
        <BulkAddSection currentCount={0} />
        <div className="mt-6 max-w-2xl text-center text-gray-600 mx-auto">
          <p>You&apos;re not watching any keywords yet.</p>
          <p className="mt-1 text-sm">
            Paste a list above, or star a keyword from{' '}
            <a className="underline" href="/explorer">the explorer</a>{' '}
            or its detail page to start watching.
          </p>
        </div>
      </div>
    );
  }

  const keywordIds = items.map((i) => i.keywordId);
  const rows = await fetchExplorerRowsByIds({
    keywordIds,
    window: filters.window,
    sort: filters.sort,
    matchMode: filters.matchMode,
  });

  const addedAtByKeyword = new Map(items.map((i) => [i.keywordId, i.addedAt]));

  // fetchExplorerRowsByIds doesn't know about added_* sort keys — re-sort
  // in JS here, since we have addedAt on hand.
  let sortedRows = rows;
  if (filters.sort === 'added_asc' || filters.sort === 'added_desc') {
    sortedRows = [...rows].sort((a, b) => {
      const ta = new Date(addedAtByKeyword.get(a.searchTermId) ?? 0).getTime();
      const tb = new Date(addedAtByKeyword.get(b.searchTermId) ?? 0).getTime();
      return filters.sort === 'added_asc' ? ta - tb : tb - ta;
    });
  }

  return (
    <div className="p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Watchlist</h1>
          <p className="text-sm text-gray-600">
            {items.length} of {MAX_WATCHED_KEYWORDS} keywords watched
          </p>
        </div>
        <WindowSelector current={filters.window} />
      </header>
      <BulkAddSection currentCount={items.length} />
      <WatchlistTable
        initialRows={sortedRows}
        window={filters.window}
        matchMode={filters.matchMode}
        currentSort={filters.sort}
        initialAddedAtByKeyword={Array.from(addedAtByKeyword.entries())}
      />
    </div>
  );
}
