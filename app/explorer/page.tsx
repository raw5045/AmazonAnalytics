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
import { listCategories } from '@/lib/explorer/listCategories';
import { FilterSidebar } from './FilterSidebar';
import { ResultsTable } from './ResultsTable';
import { Pagination } from './Pagination';
import { PerfStrip } from './PerfStrip';

export const metadata: Metadata = {
  title: 'Keyword Explorer',
};

export default async function ExplorerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
  const filters = parseExplorerFilters(sp);

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

  const handlerStartedAt = Date.now();
  // Time listCategories at the call site so we can heuristically tell
  // cache hit vs miss (cached call returns <20ms; uncached DISTINCT scan
  // is 300ms+).
  const tCategoriesStart = Date.now();
  const categoriesPromise = listCategories().then((r) => {
    return { result: r, ms: Date.now() - tCategoriesStart };
  });
  const [queryResult, categoriesTimed] = await Promise.all([
    runExplorerQuery(filters),
    categoriesPromise,
  ]);
  const { rows, total, totalIsCapped, timings: rqTimings } = queryResult;
  const categories = categoriesTimed.result;
  const handlerTotalMs = Date.now() - handlerStartedAt;

  const totalPages = Math.max(1, Math.ceil(total / filters.perPage));
  const totalLabel = totalIsCapped
    ? `${total.toLocaleString()}+`
    : total.toLocaleString();

  return (
    <div className="flex">
      <FilterSidebar filters={filters} categories={categories} />
      <div className="flex-1 p-6">
        <PerfStrip
          data={{
            handlerTotalMs,
            metaLookupMs: rqTimings.metaLookupMs,
            rowsMs: rqTimings.rowsMs,
            countMs: rqTimings.countMs,
            categoriesMs: categoriesTimed.ms,
            usedPredicate: rqTimings.usedPredicate,
            // Heuristic: cached calls usually return <20ms; uncached
            // DISTINCT scan is at least 300ms.
            categoriesCacheHint: categoriesTimed.ms < 50 ? 'fast' : 'slow',
          }}
        />
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">
            {total === 0
              ? 'No results — try removing a filter.'
              : `Showing ${(filters.page - 1) * filters.perPage + 1}–${Math.min(filters.page * filters.perPage, total)} of ${totalLabel} — page ${filters.page} of ${totalPages.toLocaleString()}${totalIsCapped ? '+' : ''}`}
          </p>
          {filtersAreCustomized(filters) && (
            <a href="/explorer" className="text-sm underline text-gray-600">
              Reset filters
            </a>
          )}
        </div>
        {totalIsCapped && (
          <p className="mb-3 text-xs text-gray-500">
            Showing the first {total.toLocaleString()} matching keywords. Add a filter to narrow the result set further.
          </p>
        )}
        <ResultsTable rows={rows} window={filters.window} matchMode={filters.matchMode} backUrl={backUrl} />
        <Pagination page={filters.page} perPage={filters.perPage} total={total} totalIsCapped={totalIsCapped} />
      </div>
    </div>
  );
}

function filtersAreCustomized(f: ReturnType<typeof parseExplorerFilters>): boolean {
  return (
    f.window !== EXPLORER_DEFAULTS.window ||
    f.q !== null ||
    f.rankMin !== null ||
    f.rankMax !== null ||
    f.jump !== null ||
    f.category !== null ||
    JSON.stringify(f.severities) !== JSON.stringify(EXPLORER_DEFAULTS.severities) ||
    JSON.stringify(f.titleSlots) !== JSON.stringify(EXPLORER_DEFAULTS.titleSlots) ||
    f.titleMatchMode !== null ||
    f.sort !== EXPLORER_DEFAULTS.sort ||
    f.page !== 1
  );
}
