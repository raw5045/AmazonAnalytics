'use client';

import dynamic from 'next/dynamic';

/**
 * Client wrapper that lazy-loads the ASIN page's recharts history charts, as the keyword page's
 * LazyCharts.tsx does for its trend chart: recharts (~100 KB gzipped) lands in an on-demand chunk,
 * not the route's first-load JS, so the title band, the facts card and the keywords table hydrate
 * at once while the charts swap in behind HistorySkeleton.
 *
 * ssr:false because recharts' ResponsiveContainer measures its width on the client and renders
 * nothing useful on the server. Per the Next 16 lazy-loading guide, ssr:false is only allowed in a
 * Client Component, hence this 'use client' boundary rather than a dynamic() call in page.tsx.
 */
export const LazyHistoryCharts = dynamic(() => import('./HistoryCharts').then((m) => m.HistoryCharts), {
  ssr: false,
  loading: () => <HistorySkeleton />,
});

/** The four chart cards' titles and plot height, kept in step with HistoryCharts.tsx. */
const SKELETON_TITLES = ['Price ($)', 'BSR', 'Reviews', 'Monthly sold'];
const CHART_HEIGHT = 160;

/**
 * The history block while its data streams in (the page's Suspense fallback) or its chart chunk
 * downloads (the dynamic import's loading state): the same frame and card heights as the charts.
 */
export function HistorySkeleton() {
  return (
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">History</h2>
        <span className="inline-flex items-center gap-2 text-xs text-gray-500">
          <span
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
            aria-hidden
          />
          Loading charts…
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {SKELETON_TITLES.map((title) => (
          <div key={title} className="card-app min-w-0 p-4">
            <div className="mb-1 text-xs font-semibold text-gray-700">{title}</div>
            <div className="animate-pulse rounded bg-gray-100" style={{ height: CHART_HEIGHT }} />
          </div>
        ))}
      </div>
    </section>
  );
}
