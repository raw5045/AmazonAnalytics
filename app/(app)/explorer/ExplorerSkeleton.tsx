/**
 * Explorer shell skeleton: sidebar pulse panel + a results area with a
 * centered spinner ring over pulse rows. Shared by:
 *   - loading.tsx (route-level fallback on navigations)
 *   - page.tsx's <Suspense> fallback (streams instantly on hard/cold loads
 *     while ExplorerResults awaits the rows query — the fix for the
 *     2026-07-10 "79s staring at nothing" report)
 */
export function ExplorerSkeleton() {
  return (
    <div className="flex">
      <aside className="w-72 border-r border-slate-200 bg-white p-4">
        <div className="h-4 w-20 animate-pulse rounded bg-gray-200" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      </aside>
      <div className="relative flex-1 p-6">
        <div className="h-4 w-64 animate-pulse rounded bg-gray-200" />
        <div className="card-app mt-4 overflow-hidden">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse border-b border-slate-100 bg-gray-50 last:border-b-0" />
          ))}
        </div>
        {/* Centered spinner ring (same look as LoadingOverlay, sans backdrop) */}
        <div className="absolute inset-0 flex items-center justify-center" role="status" aria-live="polite">
          <div className="relative h-16 w-16">
            <div className="absolute inset-0 rounded-full border-4 border-gray-200" aria-hidden="true" />
            <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-blue-600" aria-hidden="true" />
            <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700">
              Loading
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
