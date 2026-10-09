/**
 * What the ASIN page's history charts (HistoryCharts.tsx: recharts, in a lazy chunk) share with
 * their skeleton (LazyHistoryCharts.tsx, in the route's first-load JS) and the server section
 * (StreamedProductSections.tsx). No recharts import here, so the skeleton and the section can use
 * it without pulling the chart library into the route's initial bundle.
 */
import type { HistoryPoint } from '@/lib/products/loadProductHistory';

/** The fields the charts read. The page sends only these, so the client payload stays small. */
export type ChartPoint = Pick<HistoryPoint, 'fetchedAt' | 'currentPriceCents' | 'salesRank' | 'reviewCount' | 'monthlySold'>;

export type HistorySeriesKey = 'price' | 'bsr' | 'reviews' | 'sold';

/** The four small charts in display order: the card title and the note beside it. */
export const HISTORY_SERIES: ReadonlyArray<{ key: HistorySeriesKey; title: string; hint?: string }> = [
  { key: 'price', title: 'Price ($)' },
  { key: 'bsr', title: 'BSR', hint: 'lower is better · axis flipped' },
  { key: 'reviews', title: 'Reviews' },
  { key: 'sold', title: 'Monthly sold', hint: 'Amazon’s badge floor' },
];

/** Plot height of each chart, and of its skeleton block, so swapping the charts in shifts nothing. */
export const HISTORY_CHART_HEIGHT = 160;
