/**
 * /products — find ASINs by the Keepa catalog's fields (spec 2026-10-09 §5). Open to every signed-in
 * account (spec 2026-10-23 §2).
 *
 * Server component, built like /explorer:
 *   1. Signed-in gate, then parse searchParams → ProductFilters (bad values fall back per field)
 *   2. Stream the shell; behind <Suspense>, expand the custom ids, run the product search, and read
 *      the department, broad-category, path and custom-category lists
 *   3. Render the admin PerfPanel (spec 2026-10-19 §7), ProductFilterPanel, ProductResultsTable and
 *      ProductPagination (or the timeout notice in place of the last two)
 * Soft filter / sort / page changes run inside transitions, so the old results stay mounted
 * (with the loading overlay) and the skeleton only shows on initial loads.
 *
 * A search whose rows read runs into the 30 s statement cap (PRODUCT_READ_TIMEOUT_MS, SQLSTATE 57014)
 * renders an inline notice in place of the table and the pager, with the filter panel still there to
 * narrow the filters (spec 2026-10-23 §5); any other failure still throws to the error page. That
 * timeout, and a search that completes slower than SLOW_PRODUCT_SEARCH_MS, is recorded in slow_queries
 * with the filters' URL query string (§5b): fire-and-forget once the reads have settled, so the
 * recording never delays or changes the page.
 *
 * The (list) route group (no URL segment) scopes this folder's loading.tsx to the list: a
 * loading.tsx directly in products/ would also wrap /products/[asin] and flash the list skeleton
 * before the ASIN page's own. The panel, table and pager live one level up, in products/.
 */
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { neon } from '@neondatabase/serverless';
import type { User } from '@/db/schema';
import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { expandCustomCategories } from '@/lib/customCategories/expand';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { startHandlerTimer, timed, type HandlerTimer } from '@/lib/perf/handlerTimer';
import { pageCategoryScope } from '@/lib/products/categoryPredicate';
import { parseProductFilters, productFiltersToSearchParams, type ProductFilters, type SearchParamsLike } from '@/lib/products/filters';
import { listProductBroadCategories, listProductCategoryPaths, listProductDepartments } from '@/lib/products/listCategories';
import { searchProducts, neonRunner, isStatementTimeout } from '@/lib/products/searchProducts';
import { recordSlowProductSearch, SLOW_PRODUCT_SEARCH_MS } from '@/lib/products/slowQueries';
import { PerfPanel } from '@/app/(app)/PerfPanel';
import { ProductFilterPanel } from '../ProductFilterPanel';
import { ProductResultsTable } from '../ProductResultsTable';
import { ProductPagination } from '../ProductPagination';
import { ProductsSkeleton } from './loading';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsLike> }) {
  // The timer starts before the gate: the panel's total is the whole handler, as on the Watchlist.
  const timer = startHandlerTimer();
  // Page-level gate: every signed-in account may open the page (spec 2026-10-23 §2). The (app) layout
  // already requires a signed-in user, but Next renders layouts and pages in parallel, so it is
  // checked here too, before any data read.
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  timer.mark('auth');
  const filters = parseProductFilters(await searchParams);
  return (
    <Suspense fallback={<ProductsSkeleton />}>
      <ProductsResults filters={filters} user={user} timer={timer} />
    </Suspense>
  );
}

/**
 * The page's reads, in parallel, each timed on its own, and the moment they finished. The custom-category
 * ids expand (owner-scoped; unknown ids skipped, so an unowned selection scopes to nothing) before the
 * search they scope; the four option lists load alongside. One `loads` step on the timer runs from the
 * `auth` mark to the last read's settle, so it also holds the parse and the renderer's hop into the
 * Suspense content (a millisecond or two): loads minus the slowest read is that pre-read gap. The note
 * carries each read's own time ("search" includes the custom-id expansion it waits for; "paths" awaits
 * the cached departments read first, so it is never below "departments") and the path list's count and
 * raw size, the payload every load ships. The clock is read once, here on the server, and passed to the
 * (client) table as a prop: every row's listing age counts to the same instant, and hydration reuses that
 * value instead of reading the browser's clock.
 *
 * A rows read cut off by the statement cap settles the search as null instead of rejecting, so it is timed
 * like a completed one and the four lists still load for the panel; the null `result` is the page's
 * notice. A timed-out search, or one slower than SLOW_PRODUCT_SEARCH_MS, is recorded with that measured
 * time, never awaited.
 */
async function loadProductsPage(filters: ProductFilters, userId: string, timer: HandlerTimer) {
  const sql = neon(env.DATABASE_URL);
  // Only the search's own statement timeout becomes null; any other failure (the expansion's included) still rejects and fails the page.
  const searched = expandCustomCategories(userId, filters.customCategoryIds, []).then((customPaths) =>
    searchProducts(neonRunner(sql), filters, pageCategoryScope(filters, customPaths)).catch((e: unknown) => {
      if (isStatementTimeout(e)) return null;
      throw e;
    }),
  );
  // A failed department, broad-category or path read shows an empty list; caught here, outside the cached functions, so nothing empty is cached and the tools still reject.
  const [result, departments, broadCategories, leafCategories, customCategories] = await Promise.all([
    timed(searched),
    timed(listProductDepartments().catch(() => [] as string[])),
    timed(listProductBroadCategories().catch(() => [] as string[])),
    timed(listProductCategoryPaths().catch(() => [] as string[])),
    timed(listCustomCategoriesForUser(userId)),
  ]);
  const timedOut = result.value === null;
  // Fire-and-forget (spec 2026-10-23 §5b): never awaited, so the recording cannot delay or fail the page; a failed insert only warns.
  if (timedOut || result.ms > SLOW_PRODUCT_SEARCH_MS) {
    void recordSlowProductSearch({ userId, queryString: productFiltersToSearchParams(filters).toString(), elapsedMs: result.ms, timedOut });
  }
  // UTF-16 code units, a close-enough proxy for the bytes the list adds to every load (each › is 3 bytes in UTF-8, counted as 1).
  const pathChars = leafCategories.value.reduce((n, p) => n + p.length, 0);
  timer.mark(
    'loads',
    `parallel: search ${timedOut ? `timed out after ${result.ms}` : result.ms} · departments ${departments.ms} · broad ${broadCategories.ms} · paths ${leafCategories.ms} ` +
      `(${leafCategories.value.length.toLocaleString('en-US')} · ${(pathChars / 1024 / 1024).toFixed(1)} MB) · custom ${customCategories.ms} ms`,
  );
  return {
    /** null when the rows read hit the statement cap: the page shows its notice in place of the table and the pager. */
    result: result.value,
    departments: departments.value,
    broadCategories: broadCategories.value,
    leafCategories: leafCategories.value,
    customCategories: customCategories.value,
    now: new Date(),
  };
}

async function ProductsResults({ filters, user, timer }: { filters: ProductFilters; user: User; timer: HandlerTimer }) {
  const { result, departments, broadCategories, leafCategories, customCategories, now } = await loadProductsPage(filters, user.id, timer);
  // Keyed by the applied filters (page aside): a header re-sort or an Apply re-seeds the panel's
  // inputs, while paging keeps any edits not yet applied.
  const panelKey = productFiltersToSearchParams({ ...filters, page: 1 }).toString();
  return (
    <div className="flex">
      <ProductFilterPanel key={panelKey} filters={filters} departments={departments} broadCategories={broadCategories} leafCategories={leafCategories} customCategories={customCategories} />
      <div className="min-w-0 flex-1 p-6">
        <PerfPanel
          admin={user.role === 'admin'}
          data={{
            totalMs: timer.totalMs(),
            steps: timer.steps,
            footnote:
              'server-handler time only, read before the render (so the remainder row is ~0 here, not "render is free"). ' +
              'Browser-perceived total also includes Vercel function cold-start, Neon warm-up, network and rendering.',
          }}
        />
        {result === null ? (
          // The rows read hit the statement cap (spec 2026-10-23 §5): the notice stands in for the table and the pager, and the panel stays to narrow the filters.
          <p role="status" className="card-app px-4 py-6 text-sm text-gray-700">
            This combination took too long to load. Narrow the filters or try again.
          </p>
        ) : (
          <>
            <ProductResultsTable rows={result.rows} total={result.total} totalIsCapped={result.totalIsCapped} filters={filters} now={now} />
            <ProductPagination page={filters.page} total={result.total} totalIsCapped={result.totalIsCapped} pageSize={result.pageSize} />
          </>
        )}
      </div>
    </div>
  );
}
