/**
 * /explorer — Plan 3.2 keyword explorer page.
 *
 * Server component:
 *   1. Parse searchParams → ExplorerFilters (with defaults)
 *   2. Run query (paged rows + total count) via runExplorerQuery
 *   3. Fetch category list for the filter sidebar
 *   4. Render FilterSidebar + ResultsTable + Pagination
 */
import type { Metadata } from 'next';
import { parseExplorerFilters, EXPLORER_DEFAULTS, type SearchParamsLike } from '@/lib/explorer/parseFilters';
import { runExplorerQuery } from '@/lib/explorer/runQuery';
import { expandCustomCategories } from '@/lib/customCategories/expand';
import { listCategories } from '@/lib/explorer/listCategories';
import { listLeafCategories } from '@/lib/explorer/listLeafCategories';
import type { VolumeFitMeta } from '@/lib/explorer/types';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { loadSavedViewForUser } from '@/lib/savedViews/loadServer';
import { listWatchlistForUser } from '@/lib/watchlist/loadServer';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { Suspense } from 'react';
import { FilterSidebar } from './FilterSidebar';
import { ResultsTable } from './ResultsTable';
import { PaginationControls } from './Pagination';
import { ResultCountDisplay, DeferredResultCount, ResultCountSkeleton } from './ResultCount';
import { PerfStrip } from './PerfStrip';

export const metadata: Metadata = {
  title: 'Keyword Explorer',
};

// Broad ("search term contains" → Broad) matches run a substring LIKE over the
// whole active set and can take ~1–2 min. The runQuery broad path caps the DB
// statement at 115s; give the Vercel function headroom above that. Vercel Pro
// allows up to 300s; 120s is comfortably past the 115s DB cap. (Whole-word and
// all non-q filters return in well under a second — this ceiling only matters
// for the opt-in Broad path.)
export const maxDuration = 120;

export default async function ExplorerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;

  // The saved-views picker + Save button live in the layout header.
  // The page still needs the *active* view's stored filters so the
  // bookmark URL shape (`/explorer?view=<id>` with no filter params)
  // can hydrate its sidebar from the view's saved JSON.
  const user = await getCurrentUser();
  const viewId = getOne(sp.view);
  const [activeView, watchlistItems, customCategories] = await Promise.all([
    user && viewId ? loadSavedViewForUser(user.id, viewId) : Promise.resolve(null),
    user ? listWatchlistForUser(user.id) : Promise.resolve([]),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  const watchedKeywordIds = new Set(watchlistItems.map((w) => w.keywordId));

  // Two URL shapes are supported:
  //   1. Bookmark form: `/explorer?view=<id>` (no other filter params)
  //      → hydrate filters from the view's stored JSON.
  //   2. Full form: `/explorer?<filter params>` (no view tag)
  //      → use the URL filters directly. The dropdown stays blank.
  //
  // Apply in FilterSidebar always drops the view tag, so the moment a
  // user modifies a loaded view the URL becomes shape (2), the chip
  // blanks out, and the URL is the single source of truth. The hybrid
  // shape `?view=<id>&<filters>` is no longer produced by the UI but
  // is still accepted (URL filters win, view tag = metadata only).
  const urlHasFilters = Object.keys(sp).some(
    (k) => k !== 'view' && k !== 'page' && k !== 'per_page',
  );
  const filters = activeView && !urlHasFilters
    ? activeView.filters
    : parseExplorerFilters(sp);

  // Build the back-URL that detail pages will return to. Re-serializes
  // the current filter state so users don't lose their filters when
  // they click into a keyword and click back.
  const backQuery = new URLSearchParams();
  for (const [k, v] of Object.entries(sp ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((vv) => backQuery.append(k, vv));
    else backQuery.set(k, v);
  }
  const backUrl = backQuery.toString() ? `/explorer?${backQuery.toString()}` : '/explorer';

  // Expand any by-reference custom categories into the leaf-name filter — but
  // only for the QUERY. Keep the original `filters` (with customCategoryIds, not
  // the expanded leaves) for the sidebar/backUrl so the UI shows the user's
  // selection, not the expanded leaf set.
  let queryFilters = filters;
  if (user && filters.customCategoryIds.length > 0) {
    const merged = await expandCustomCategories(user.id, filters.customCategoryIds, filters.leafCategories);
    queryFilters = { ...filters, leafCategories: merged };
  }

  const handlerStartedAt = Date.now();
  // Time listCategories at the call site so we can heuristically tell
  // cache hit vs miss (cached call returns <20ms; uncached DISTINCT scan
  // is 300ms+).
  const tCategoriesStart = Date.now();
  const categoriesPromise = listCategories().then((r) => {
    return { result: r, ms: Date.now() - tCategoriesStart };
  });
  const leafCategoriesPromise = listLeafCategories();
  const [queryResult, categoriesTimed, leafCategories] = await Promise.all([
    runExplorerQuery(queryFilters),
    categoriesPromise,
    leafCategoriesPromise,
  ]);
  const { rows, hasNext, total, totalIsCapped, volumeFit, broadTimedOut, timings: rqTimings } = queryResult;
  const categories = categoriesTimed.result;
  const handlerTotalMs = Date.now() - handlerStartedAt;

  // Lower bound shown immediately ("Showing 101–200"); the exact total + page
  // count stream in via <ResultCount> below.
  const firstRow = rows.length === 0 ? 0 : (filters.page - 1) * filters.perPage + 1;
  const lastRow = (filters.page - 1) * filters.perPage + rows.length;

  return (
    <div className="flex">
      {/* key forces a remount when the active view changes so the
          sidebar's `pending` state re-initializes from the new
          filters. Without this, picking a view in the dropdown
          updates the URL + results but leaves the sidebar inputs
          showing the old (pre-selection) values. */}
      <FilterSidebar
        key={activeView?.id ?? 'no-view'}
        filters={filters}
        categories={categories}
        leafCategories={leafCategories}
        customCategories={customCategories}
      />
      <div className="flex-1 p-6">
        <PerfStrip
          data={{
            handlerTotalMs,
            metaLookupMs: rqTimings.metaLookupMs,
            rowsMs: rqTimings.rowsMs,
            countMs: rqTimings.countMs,
            categoriesMs: categoriesTimed.ms,
            usedPredicate: rqTimings.usedPredicate,
            countSource: rqTimings.countSource,
            // Heuristic: cached calls usually return <20ms; uncached
            // DISTINCT scan is at least 300ms.
            categoriesCacheHint: categoriesTimed.ms < 50 ? 'fast' : 'slow',
          }}
        />
        {broadTimedOut ? (
          // Broad match exceeded the time budget. rows/total are empty here, so
          // the normal "No results" copy would be misleading — show a distinct,
          // actionable notice instead of an empty table.
          <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-medium">This broad search matched too many keywords to rank in time.</p>
            <p className="mt-1">
              Narrow it with another filter (rank range, category, or severity), or switch{' '}
              <strong>Search term contains</strong> back to <strong>Whole word</strong> for a fast,
              exact-word match.
            </p>
            {filtersAreCustomized(filters) && (
              <a href="/explorer" className="mt-2 inline-block underline">
                Reset filters
              </a>
            )}
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                {rows.length === 0 ? (
                  'No results — try removing a filter.'
                ) : total !== null ? (
                  // Cheaply-known total (default landing / single leaf / q-path): inline, no flash.
                  <span className="flex items-center gap-1">
                    <span>Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of</span>
                    <ResultCountDisplay total={total} totalIsCapped={totalIsCapped} page={filters.page} perPage={filters.perPage} />
                  </span>
                ) : (
                  // Heavy live-count case: rows now, exact total streams in.
                  <span className="flex items-center gap-1">
                    <span>Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} ·</span>
                    <Suspense fallback={<ResultCountSkeleton />}>
                      <DeferredResultCount filters={queryFilters} page={filters.page} perPage={filters.perPage} />
                    </Suspense>
                  </span>
                )}
              </div>
              {filtersAreCustomized(filters) && (
                <a href="/explorer" className="text-sm underline text-gray-600">Reset filters</a>
              )}
            </div>
            {volumeFit && <VolumeFitChip fit={volumeFit} />}
            <ResultsTable
              rows={rows}
              window={filters.window}
              matchMode={filters.matchMode}
              currentSort={filters.sort}
              backUrl={backUrl}
              watchedKeywordIds={watchedKeywordIds}
              showWatchColumn={Boolean(user)}
            />
            <PaginationControls page={filters.page} hasNext={hasNext} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Small inline chip that tells the user where the est-monthly-volume
 * numbers came from. Shown above the results table.
 */
function VolumeFitChip({ fit }: { fit: VolumeFitMeta }) {
  // calibrationMonthEndDate is YYYY-MM-DD (the last day of the month).
  // Render as "Month YYYY" — friendlier than the raw date.
  const monthLabel = formatMonthLabel(fit.calibrationMonthEndDate);
  return (
    <div className="mb-3 inline-flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">
      <span>
        Est. monthly volume from <strong>{monthLabel}</strong> calibration fit
      </span>
      {fit.isExtrapolated && (
        <span
          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-800"
          title="No calibration data exists yet for this week or any earlier week — the explorer falls back to the earliest available fit. Numbers should be treated as rough estimates."
        >
          extrapolated
        </span>
      )}
    </div>
  );
}

function formatMonthLabel(isoYyyyMmDd: string): string {
  const [y, m] = isoYyyyMmDd.split('-');
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const idx = parseInt(m, 10) - 1;
  return idx >= 0 && idx < 12 ? `${monthNames[idx]} ${y}` : isoYyyyMmDd;
}

/** Same helper used inside parseFilters; inlined since it's not exported. */
function getOne(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function filtersAreCustomized(f: ReturnType<typeof parseExplorerFilters>): boolean {
  return (
    f.window !== EXPLORER_DEFAULTS.window ||
    f.q !== null ||
    f.rankMin !== null ||
    f.rankMax !== null ||
    f.jump !== null ||
    f.category !== null ||
    f.leafCategories.length > 0 ||
    f.customCategoryIds.length > 0 ||
    JSON.stringify(f.severities) !== JSON.stringify(EXPLORER_DEFAULTS.severities) ||
    JSON.stringify(f.titleSlots) !== JSON.stringify(EXPLORER_DEFAULTS.titleSlots) ||
    f.titleMatchMode !== null ||
    f.sort !== EXPLORER_DEFAULTS.sort ||
    f.page !== 1
  );
}
