/**
 * Instant route-level skeleton for /category-builder. The page awaits the
 * (large) category tree + serializes it into the payload, so without this the
 * navigation sits on a blank/old screen. Mirrors the two-column layout to
 * minimise layout shift, with a spinner so the wait reads as "loading".
 */
export default function CategoryBuilderLoading() {
  return (
    <div className="p-6">
      <div className="mb-4 h-6 w-44 animate-pulse rounded bg-gray-200" />
      <div className="flex items-start gap-6">
        {/* Left: drill-down browser skeleton */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-200">
          <div className="h-9 animate-pulse border-b border-gray-200 bg-gray-50" />
          <ul>
            {Array.from({ length: 12 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5 last:border-b-0"
              >
                <div className="h-4 w-1/2 animate-pulse rounded bg-gray-100" />
                <div className="h-4 w-10 animate-pulse rounded bg-gray-100" />
              </li>
            ))}
          </ul>
        </div>
        {/* Right: build panel skeleton */}
        <div className="flex w-80 shrink-0 flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <div className="h-10 animate-pulse border-b border-gray-200 bg-gray-50" />
            <div className="space-y-3 p-4">
              <div className="h-8 animate-pulse rounded bg-gray-100" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100" />
              <div className="h-8 animate-pulse rounded bg-gray-100" />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm text-gray-400">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
        Loading categories…
      </div>
    </div>
  );
}
