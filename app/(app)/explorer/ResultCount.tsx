import { countExplorerMatches } from '@/lib/explorer/runQuery';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { JumpToPage } from './JumpToPage';

/** Pure presentational total + page-of-pages + jump-to. Used inline when the
 *  total is cheaply known, and by DeferredResultCount once the count resolves. */
export function ResultCountDisplay({
  total, totalIsCapped, page, perPage,
}: { total: number; totalIsCapped: boolean; page: number; perPage: number }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const cap = totalIsCapped ? '+' : '';
  return (
    <span className="flex items-center text-sm text-gray-600">
      <span>
        {total.toLocaleString()}{cap} matches · page {page.toLocaleString()} of{' '}
        {totalPages.toLocaleString()}{cap}
      </span>
      {totalPages > 1 && <JumpToPage page={page} totalPages={totalPages} />}
    </span>
  );
}

/** Async server component: fetches the bounded count and streams it in. On
 *  timeout/error the count is null → graceful footer (pagination still works
 *  from the Prev/Next controls). */
export async function DeferredResultCount({
  filters, page, perPage,
}: { filters: ExplorerFilters; page: number; perPage: number }) {
  const result = await countExplorerMatches(filters);
  if (!result) {
    return (
      <span className="text-sm text-gray-500">
        Many matches — narrow the filters to see an exact count.
      </span>
    );
  }
  return (
    <ResultCountDisplay
      total={result.total}
      totalIsCapped={result.totalIsCapped}
      page={page}
      perPage={perPage}
    />
  );
}

/** Suspense fallback shown while the count resolves. */
export function ResultCountSkeleton() {
  return <span className="text-sm text-gray-400 animate-pulse">counting matches…</span>;
}
