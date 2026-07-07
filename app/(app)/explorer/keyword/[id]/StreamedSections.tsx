/**
 * Streamed chart / strips / variants sections for the keyword detail page.
 *
 * All three consume data that can be slow on a cold Neon cache (the
 * keyword_chart_series read was measured at 1.5-15s when its storage layers
 * go cold — see the 2026-07-07 investigation), so they render behind
 * <Suspense> while the header paints immediately from the fast loader.
 *
 * TrendChartSection and StripsSection share ONE series read:
 * fetchKeywordChartHistory is wrapped in React cache(), so the second caller
 * reuses the first's in-flight promise within this request.
 *
 * Like TopProductsSection, each carries its own try/catch fail-soft body and
 * NO client error boundary wraps the <Suspense> — that would de-opt the
 * server streaming that lets the header paint first.
 */
import {
  fetchKeywordChartHistory,
  fetchCurrentWeekVariants,
} from '@/lib/explorer/fetchKeywordDetail';
import { LazyTrendChart } from './LazyCharts';
import { ChartSkeleton } from './ChartSkeleton';
import { FakeVolumeStrip } from './FakeVolumeStrip';
import { TitleMatchHistory } from './TitleMatchHistory';
import { KeywordVariantsBox } from './KeywordVariantsBox';

export async function TrendChartSection({
  id,
  latestWeek,
}: {
  id: string;
  latestWeek: string;
}) {
  let history;
  try {
    history = await fetchKeywordChartHistory(id);
  } catch (e) {
    console.error('[trend chart] load failed', e);
    return (
      <div className="card-app p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Est. volume trend (52w)</h2>
        <p className="text-sm text-gray-500">
          Couldn&apos;t load the chart — refresh to retry. (The rest of the page is unaffected.)
        </p>
      </div>
    );
  }
  return <LazyTrendChart history={history} latestWeek={latestWeek} />;
}

export async function StripsSection({
  id,
  latestWeek,
}: {
  id: string;
  latestWeek: string;
}) {
  let history;
  try {
    history = await fetchKeywordChartHistory(id);
  } catch (e) {
    console.error('[strips] load failed', e);
    return (
      <div className="card-app p-4 lg:col-span-2">
        <p className="text-sm text-gray-500">
          Couldn&apos;t load the fake-volume / title-match strips — refresh to retry.
        </p>
      </div>
    );
  }
  return (
    <>
      <FakeVolumeStrip history={history} latestWeek={latestWeek} />
      <TitleMatchHistory history={history} latestWeek={latestWeek} />
    </>
  );
}

/** Grid-item skeletons matching the two strip cards. */
export function StripsSkeleton() {
  return (
    <>
      <ChartSkeleton title="Fake-volume history (52w)" height={56} />
      <ChartSkeleton title="Keyword in product title (52w)" height={56} />
    </>
  );
}

export async function VariantsSection({
  id,
  currentWeekEndDate,
}: {
  id: string;
  currentWeekEndDate: string;
}) {
  let variants;
  try {
    variants = await fetchCurrentWeekVariants(id, currentWeekEndDate);
  } catch (e) {
    // Informational box — omit it on failure rather than showing an error.
    console.error('[variants] load failed', e);
    return null;
  }
  if (!variants) return null;
  return (
    <section className="mt-6">
      <KeywordVariantsBox weekEndDate={currentWeekEndDate} variants={variants} />
    </section>
  );
}
