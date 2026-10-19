/**
 * /products — find ASINs by the Keepa catalog's fields (spec 2026-10-09 §5). Admin only (§10).
 *
 * Server component, built like /explorer:
 *   1. Admin gate, then parse searchParams → ProductFilters (bad values fall back per field)
 *   2. Stream the shell; behind <Suspense>, expand the custom ids, run the product search, and read
 *      the department, broad-category, path and custom-category lists
 *   3. Render the admin PerfPanel (spec 2026-10-19 §7), ProductFilterPanel, ProductResultsTable and
 *      ProductPagination
 * Soft filter / sort / page changes run inside transitions, so the old results stay mounted
 * (with the loading overlay) and the skeleton only shows on initial loads.
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
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { expandCustomCategories } from '@/lib/customCategories/expand';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { startHandlerTimer, timed, type HandlerTimer } from '@/lib/perf/handlerTimer';
import { pageCategoryScope } from '@/lib/products/categoryPredicate';
import { parseProductFilters, productFiltersToSearchParams, type ProductFilters, type SearchParamsLike } from '@/lib/products/filters';
import { listProductBroadCategories, listProductCategoryPaths, listProductDepartments } from '@/lib/products/listCategories';
import { searchProducts, neonRunner } from '@/lib/products/searchProducts';
import { PerfPanel } from '@/app/(app)/PerfPanel';
import { ProductFilterPanel } from '../ProductFilterPanel';
import { ProductResultsTable } from '../ProductResultsTable';
import { ProductPagination } from '../ProductPagination';
import { ProductsSkeleton } from './loading';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsLike> }) {
  // The timer starts before the gate: the panel's total is the whole handler, as on the Watchlist.
  const timer = startHandlerTimer();
  // Page-level gate, as app/admin/keepa-enrichment/page.tsx does it: checked here before any data
  // read (the (app) layout only requires a signed-in user, and Next renders layouts and pages in
  // parallel). The Products tab itself shows only for admins.
  let user: User;
  try {
    user = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
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
 * search they scope; the four option lists load alongside. One `loads` step on the timer = the wall time
 * of all five, with the per-read times (and the path list's count and raw size, the payload every load
 * ships) in its note. The clock is read once, here on the server, and passed to the (client) table as a
 * prop: every row's listing age counts to the same instant, and hydration reuses that value instead of
 * reading the browser's clock.
 */
async function loadProductsPage(filters: ProductFilters, userId: string, timer: HandlerTimer) {
  const sql = neon(env.DATABASE_URL);
  const searched = expandCustomCategories(userId, filters.customCategoryIds, []).then((customPaths) =>
    searchProducts(neonRunner(sql), filters, pageCategoryScope(filters, customPaths)),
  );
  // A failed department, broad-category or path read shows an empty list; caught here, outside the cached functions, so nothing empty is cached and the tools still reject.
  const [result, departments, broadCategories, leafCategories, customCategories] = await Promise.all([
    timed(searched),
    timed(listProductDepartments().catch(() => [] as string[])),
    timed(listProductBroadCategories().catch(() => [] as string[])),
    timed(listProductCategoryPaths().catch(() => [] as string[])),
    timed(listCustomCategoriesForUser(userId)),
  ]);
  // UTF-16 code units, a close-enough proxy for the bytes the list adds to every load (each › is 3 bytes in UTF-8, counted as 1).
  const pathChars = leafCategories.value.reduce((n, p) => n + p.length, 0);
  timer.mark(
    'loads',
    `parallel: search ${result.ms} · departments ${departments.ms} · broad ${broadCategories.ms} · paths ${leafCategories.ms} ` +
      `(${leafCategories.value.length.toLocaleString('en-US')} · ${(pathChars / 1024 / 1024).toFixed(1)} MB) · custom ${customCategories.ms} ms`,
  );
  return {
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
        <PerfPanel admin={user.role === 'admin'} data={{ totalMs: timer.totalMs(), steps: timer.steps }} />
        <ProductResultsTable rows={result.rows} total={result.total} totalIsCapped={result.totalIsCapped} filters={filters} now={now} />
        <ProductPagination page={filters.page} total={result.total} totalIsCapped={result.totalIsCapped} pageSize={result.pageSize} />
      </div>
    </div>
  );
}
