import { cache } from 'react';
import { countExplorerMatches } from '@/lib/explorer/runQuery';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { JumpToPage } from './JumpToPage';

// Request-level dedup: the count is read twice this render — the top summary
// ("N matches") and the bottom pagination ("Page X of M"). cache() collapses
// both reads to a single countExplorerMatches() call (one DB round-trip).
export const getExplorerCount = cache(countExplorerMatches);

/** Top-summary total ("N matches") + jump-to. Used inline when the total is
 *  cheaply known, and by DeferredResultCount once the count resolves. The
 *  "Page X of M" lives in the bottom pagination bar (see PageOf). */
export function ResultCountDisplay({
  total, totalIsCapped, page, perPage,
}: { total: number; totalIsCapped: boolean; page: number; perPage: number }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const cap = totalIsCapped ? '+' : '';
  return (
    <span className="flex items-center text-sm text-gray-600">
      <span>{total.toLocaleString()}{cap} matches</span>
      {totalPages > 1 && <JumpToPage page={page} totalPages={totalPages} />}
    </span>
  );
}

/** Async server component: fetches the bounded count and streams the top
 *  summary in. On timeout/error → graceful note; pagination still works. */
export async function DeferredResultCount({
  filters, page, perPage,
}: { filters: ExplorerFilters; page: number; perPage: number }) {
  const result = await getExplorerCount(filters);
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

/** The " of M" suffix rendered right after "Page N" in the bottom pagination
 *  bar. Inline form, used when the total is cheaply known. */
export function PageOf({
  total, totalIsCapped, perPage,
}: { total: number; totalIsCapped: boolean; perPage: number }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return <> of {totalPages.toLocaleString()}{totalIsCapped ? '+' : ''}</>;
}

/** Deferred " of M" suffix — streams into the bottom bar via the SAME cached
 *  count as the top summary, so it adds no extra DB work. Renders nothing on
 *  timeout/error, leaving a bare "Page N". */
export async function DeferredPageOf({
  filters, perPage,
}: { filters: ExplorerFilters; perPage: number }) {
  const result = await getExplorerCount(filters);
  if (!result) return null;
  return <PageOf total={result.total} totalIsCapped={result.totalIsCapped} perPage={perPage} />;
}
