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

  const [{ rows, total }, categories] = await Promise.all([
    runExplorerQuery(filters),
    listCategories(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / filters.perPage));

  return (
    <div className="flex">
      <FilterSidebar filters={filters} categories={categories} />
      <div className="flex-1 p-6">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">
            {total === 0
              ? 'No results — try removing a filter.'
              : `Showing ${(filters.page - 1) * filters.perPage + 1}–${Math.min(filters.page * filters.perPage, total)} of ${total.toLocaleString()} — page ${filters.page} of ${totalPages.toLocaleString()}`}
          </p>
          {filtersAreCustomized(filters) && (
            <a href="/explorer" className="text-sm underline text-gray-600">
              Reset filters
            </a>
          )}
        </div>
        <ResultsTable rows={rows} window={filters.window} />
        <Pagination page={filters.page} perPage={filters.perPage} total={total} />
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
