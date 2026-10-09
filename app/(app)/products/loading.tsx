import { LoadingIndicator } from '@/app/(app)/explorer/LoadingIndicator';

/**
 * Products shell skeleton: the top progress bar, a filter-panel block and ten grey rows under a
 * centred spinner ring, like the explorer's. Shared by this file's route-level fallback and the
 * page's own <Suspense> fallback (which streams while the search query runs).
 */
export function ProductsSkeleton() {
  return (
    <>
      <LoadingIndicator label="products" />
      <div className="flex">
        <aside className="w-72 shrink-0 border-r border-slate-200 bg-white p-4">
          <div className="h-4 w-20 animate-pulse rounded bg-gray-200" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        </aside>
        <div className="relative min-w-0 flex-1 p-6">
          <div className="h-4 w-48 animate-pulse rounded bg-gray-200" />
          <div className="card-app mt-4 overflow-hidden">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse border-b border-slate-100 bg-gray-50 last:border-b-0" />
            ))}
          </div>
          {/* Centred spinner ring (same look as LoadingOverlay, without the backdrop). */}
          <div className="absolute inset-0 flex items-center justify-center" role="status" aria-live="polite">
            <div className="relative h-16 w-16">
              <div className="absolute inset-0 rounded-full border-4 border-gray-200" aria-hidden="true" />
              <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-blue-600" aria-hidden="true" />
              <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700">Loading</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function ProductsLoading() {
  return <ProductsSkeleton />;
}
