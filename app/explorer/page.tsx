/**
 * /explorer — Plan 3.2 keyword explorer page.
 *
 * Server component shape (post-perf-RFC):
 *   1. Parse searchParams → ExplorerFilters (with defaults).
 *   2. AWAIT the rows query + the categories fetch (both fast).
 *   3. Render the table immediately.
 *   4. Wrap the pagination footer + "Showing X of Y" line in
 *      <Suspense>, kicking off the COUNT query but NOT awaiting at
 *      the page level — React streams the footer in when the count
 *      resolves. Critical when filter combinations require a live
 *      COUNT(*) that can take seconds on cold Neon.
 *
 * The count Promise is started at the page level (so it runs in
 * parallel with rows + categories) and passed into the Suspense'd
 * subcomponent.
 */
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { parseExplorerFilters, EXPLORER_DEFAULTS, type SearchParamsLike } from '@/lib/explorer/parseFilters';
import {
  runExplorerRows,
  runExplorerCount,
  type ExplorerCountResult,
} from '@/lib/explorer/runQuery';
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

  // Kick off the count Promise immediately so it runs in parallel
  // with rows + categories, but do NOT await it at the page level.
  // The Suspense'd <CountDependentSection /> awaits it instead, so
  // the table can render before the count is ready.
  const countPromise = runExplorerCount(filters);

  const tCategoriesStart = Date.now();
  const categoriesPromise = listCategories().then((r) => ({ result: r, ms: Date.now() - tCategoriesStart }));

  const [rowsResult, categoriesTimed] = await Promise.all([
    runExplorerRows(filters),
    categoriesPromise,
  ]);
  const { rows, timings: rqTimings } = rowsResult;
  const categories = categoriesTimed.result;
  const handlerTotalMs = Date.now() - handlerStartedAt;

  return (
    <div className="flex">
      <FilterSidebar filters={filters} categories={categories} />
      <div className="flex-1 p-6">
        <Suspense fallback={null}>
          <PerfStripWithCount
            handlerTotalMs={handlerTotalMs}
            metaLookupMs={rqTimings.metaLookupMs}
            rowsMs={rqTimings.rowsMs}
            categoriesMs={categoriesTimed.ms}
            usedPredicate={rqTimings.usedPredicate}
            countPromise={countPromise}
          />
        </Suspense>

        <Suspense
          fallback={
            <ResultsHeaderSkeleton
              filters={filters}
              isCustomized={filtersAreCustomized(filters)}
            />
          }
        >
          <ResultsHeader
            filters={filters}
            isCustomized={filtersAreCustomized(filters)}
            countPromise={countPromise}
          />
        </Suspense>

        <ResultsTable rows={rows} window={filters.window} matchMode={filters.matchMode} backUrl={backUrl} />

        <Suspense fallback={<PaginationSkeleton />}>
          <PaginationSection
            page={filters.page}
            perPage={filters.perPage}
            countPromise={countPromise}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Awaits the count to render the actual perf strip with countMs + source. */
async function PerfStripWithCount(props: {
  handlerTotalMs: number;
  metaLookupMs: number;
  rowsMs: number;
  categoriesMs: number;
  usedPredicate: boolean;
  countPromise: Promise<ExplorerCountResult>;
}) {
  const { timings: countTimings } = await props.countPromise;
  return (
    <PerfStrip
      data={{
        handlerTotalMs: props.handlerTotalMs,
        metaLookupMs: props.metaLookupMs,
        rowsMs: props.rowsMs,
        countMs: countTimings.countMs,
        categoriesMs: props.categoriesMs,
        usedPredicate: props.usedPredicate,
        countSource: countTimings.countSource,
        categoriesCacheHint: props.categoriesMs < 50 ? 'fast' : 'slow',
      }}
    />
  );
}

/** Awaits the count to render the "Showing X of Y — page Z of N" header. */
async function ResultsHeader(props: {
  filters: ReturnType<typeof parseExplorerFilters>;
  isCustomized: boolean;
  countPromise: Promise<ExplorerCountResult>;
}) {
  const { total, totalIsCapped } = await props.countPromise;
  const totalPages = Math.max(1, Math.ceil(total / props.filters.perPage));
  const totalLabel = totalIsCapped ? `${total.toLocaleString()}+` : total.toLocaleString();
  const start = (props.filters.page - 1) * props.filters.perPage + 1;
  const end = Math.min(props.filters.page * props.filters.perPage, total);
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-600">
          {total === 0
            ? 'No results — try removing a filter.'
            : `Showing ${start}–${end} of ${totalLabel} — page ${props.filters.page} of ${totalPages.toLocaleString()}${totalIsCapped ? '+' : ''}`}
        </p>
        {props.isCustomized && (
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
    </>
  );
}

/** Skeleton used while the count is in flight. Keeps the layout stable. */
function ResultsHeaderSkeleton({
  filters,
  isCustomized,
}: {
  filters: ReturnType<typeof parseExplorerFilters>;
  isCustomized: boolean;
}) {
  const start = (filters.page - 1) * filters.perPage + 1;
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Showing {start}–{start + filters.perPage - 1} of <span className="inline-block h-3 w-16 bg-gray-200 rounded animate-pulse align-middle" /> — page {filters.page} of <span className="inline-block h-3 w-8 bg-gray-200 rounded animate-pulse align-middle" />
        </p>
        {isCustomized && (
          <a href="/explorer" className="text-sm underline text-gray-600">
            Reset filters
          </a>
        )}
      </div>
    </>
  );
}

/** Awaits the count to render pagination. */
async function PaginationSection(props: {
  page: number;
  perPage: number;
  countPromise: Promise<ExplorerCountResult>;
}) {
  const { total, totalIsCapped } = await props.countPromise;
  return <Pagination page={props.page} perPage={props.perPage} total={total} totalIsCapped={totalIsCapped} />;
}

function PaginationSkeleton() {
  return (
    <div className="mt-4 flex justify-center">
      <div className="h-8 w-64 bg-gray-100 rounded animate-pulse" />
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
