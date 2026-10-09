/**
 * /products — find ASINs by the Keepa catalog's fields (spec 2026-10-09 §5). Admin only (§10).
 *
 * Server component, built like /explorer:
 *   1. Admin gate, then parse searchParams → ProductFilters (bad values fall back per field)
 *   2. Stream the shell; behind <Suspense>, run the product search and read the category list
 *   3. Render ProductFilterPanel + ProductResultsTable + ProductPagination
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
import { env } from '@/lib/env';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { parseProductFilters, productFiltersToSearchParams, type ProductFilters, type SearchParamsLike } from '@/lib/products/filters';
import { searchProducts, neonRunner } from '@/lib/products/searchProducts';
import { listLeafCategories } from '@/lib/explorer/listLeafCategories';
import { ProductFilterPanel } from '../ProductFilterPanel';
import { ProductResultsTable } from '../ProductResultsTable';
import { ProductPagination } from '../ProductPagination';
import { ProductsSkeleton } from './loading';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsLike> }) {
  // Page-level gate, as app/admin/keepa-enrichment/page.tsx does it: checked here before any data
  // read (the (app) layout only requires a signed-in user, and Next renders layouts and pages in
  // parallel). The Products tab itself shows only for admins.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  const filters = parseProductFilters(await searchParams);
  return (
    <Suspense fallback={<ProductsSkeleton />}>
      <ProductsResults filters={filters} />
    </Suspense>
  );
}

/**
 * The page's two reads, in parallel, and the moment they finished. The clock is read once, here on
 * the server, and passed to the (client) table as a prop: every row's listing age counts to the
 * same instant, and hydration reuses that value instead of reading the browser's clock.
 */
async function loadProductsPage(filters: ProductFilters) {
  const sql = neon(env.DATABASE_URL);
  const [result, leafCategories] = await Promise.all([searchProducts(neonRunner(sql), filters), listLeafCategories()]);
  return { result, leafCategories, now: new Date() };
}

async function ProductsResults({ filters }: { filters: ProductFilters }) {
  const { result, leafCategories, now } = await loadProductsPage(filters);
  // Keyed by the applied filters (page aside): a header re-sort or an Apply re-seeds the panel's
  // inputs, while paging keeps any edits not yet applied.
  const panelKey = productFiltersToSearchParams({ ...filters, page: 1 }).toString();
  return (
    <div className="flex">
      <ProductFilterPanel key={panelKey} filters={filters} leafCategories={leafCategories} />
      <div className="min-w-0 flex-1 p-6">
        <ProductResultsTable rows={result.rows} total={result.total} totalIsCapped={result.totalIsCapped} filters={filters} now={now} />
        <ProductPagination page={filters.page} total={result.total} totalIsCapped={result.totalIsCapped} pageSize={result.pageSize} />
      </div>
    </div>
  );
}
