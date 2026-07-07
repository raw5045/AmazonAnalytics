/**
 * Loading placeholder for the lazily-loaded recharts charts (RankChart /
 * VolumeChart). Mirrors the chart card's frame + height so swapping in the real
 * chart causes no layout shift, and reads clearly as "loading" (not "broken")
 * — the same lesson as the weekly-history skeleton.
 */
export function ChartSkeleton({ title, height = 280 }: { title: string; height?: number }) {
  return (
    <div className="card-app p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        <span className="inline-flex items-center gap-2 text-xs text-gray-500">
          <span
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
            aria-hidden
          />
          Loading chart…
        </span>
      </div>
      <div className="animate-pulse rounded bg-gray-100" style={{ height }} />
    </div>
  );
}
