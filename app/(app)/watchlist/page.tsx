/**
 * /watchlist — Plan 3.4.2 watchlist page.
 *
 * Server component that:
 *   1. Loads the user's watchlist items (already auth-guarded by the
 *      parent (app) layout)
 *   2. Loads explorer-row data for those IDs via fetchExplorerRowsByIds
 *   3. Renders ResultsTable + the small window selector at top
 *
 * Phase 7a renders without the "Added" column or the row-removal
 * client wrapper — those land in Phase 7b. For now, clicking ★ on a
 * row triggers WatchStar's built-in router.refresh() which reloads
 * the page (without the un-watched row).
 */
import type { Metadata } from 'next';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { listWatchlistForUser } from '@/lib/watchlist/loadServer';
import { fetchExplorerRowsByIds } from '@/lib/explorer/fetchExplorerRowsByIds';
import { parseExplorerFilters, type SearchParamsLike } from '@/lib/explorer/parseFilters';
import { ResultsTable } from '@/app/(app)/explorer/ResultsTable';
import { WindowSelector } from './WindowSelector';

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
      <div className="p-6 max-w-3xl mx-auto text-center text-gray-600">
        <h1 className="text-2xl font-semibold mb-4">Watchlist</h1>
        <p>You&apos;re not watching any keywords yet.</p>
        <p className="mt-1 text-sm">
          Star a keyword from{' '}
          <a className="underline" href="/explorer">the explorer</a>{' '}
          or its detail page to start watching.
        </p>
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

  const watchedKeywordIds = new Set(keywordIds);

  return (
    <div className="p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Watchlist</h1>
          <p className="text-sm text-gray-600">
            {items.length} of 100 keywords watched
          </p>
        </div>
        <WindowSelector current={filters.window} />
      </header>
      <ResultsTable
        rows={rows}
        window={filters.window}
        matchMode={filters.matchMode}
        currentSort={filters.sort}
        backUrl="/watchlist"
        watchedKeywordIds={watchedKeywordIds}
        showWatchColumn={true}
      />
    </div>
  );
}
