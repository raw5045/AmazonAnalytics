'use client';

import dynamic from 'next/dynamic';
import { ChartSkeleton } from './ChartSkeleton';

/**
 * Client wrappers that lazy-load the two recharts charts.
 *
 * recharts is ~103 KB gzipped — the single biggest JS chunk in the app — and is
 * used ONLY by these two charts. Loading them via next/dynamic keeps recharts
 * out of the detail route's initial client bundle, so the header, current-week
 * numbers, top-products, weekly-history, and the two lightweight (recharts-free)
 * charts hydrate immediately; the recharts charts swap in behind a ChartSkeleton.
 *
 * ssr:false because recharts' <ResponsiveContainer> renders nothing useful on
 * the server anyway (it measures the container width on the client), so server-
 * rendering it just adds cost for no visible chart. The chunk is also warmed
 * from the explorer list (see ChartChunkWarmer), so it's usually already cached
 * by the time the user opens their first keyword.
 *
 * Per the Next 16 lazy-loading guide, ssr:false requires a Client Component —
 * hence this 'use client' boundary instead of calling dynamic() in the server
 * page.tsx (which also wouldn't code-split a Client Component import).
 */
export const LazyRankChart = dynamic(() => import('./RankChart').then((m) => m.RankChart), {
  ssr: false,
  loading: () => <ChartSkeleton title="Rank trend (52w)" />,
});

export const LazyVolumeChart = dynamic(() => import('./VolumeChart').then((m) => m.VolumeChart), {
  ssr: false,
  loading: () => <ChartSkeleton title="Est. volume trend (52w)" />,
});
