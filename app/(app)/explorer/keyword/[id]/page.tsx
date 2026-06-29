/**
 * /explorer/keyword/<id> — keyword detail page (Plan 3.3 / T5 fast-first-view).
 *
 * Server component:
 *   1. Validate the [id] param (cheap 404 path)
 *   2. Call fetchKeywordChartData (FAST): reads keyword_chart_series + kcs +
 *      fits + current-week variants — everything the header + 4 charts need,
 *      all from compact, stays-warm tables.
 *   3. Stream the "Top clicked products" box (fetchKeywordProducts) and the
 *      "Weekly history" table (fetchKeywordRawHistory) behind <Suspense> — both
 *      read the 140M-row kwm table, a ~2s cold-page hotspot, off the critical path.
 */
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchKeywordChartData } from '@/lib/explorer/fetchKeywordDetail';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { isKeywordWatched } from '@/lib/watchlist/loadServer';
import { WatchToggle } from '@/app/(app)/_components/WatchToggle';
import { PerfPanel } from '@/app/(app)/PerfPanel';
import { startHandlerTimer } from '@/lib/perf/handlerTimer';
import { BackToExplorer } from './BackToExplorer';
import { LazyRankChart, LazyVolumeChart } from './LazyCharts';
import { FakeVolumeStrip } from './FakeVolumeStrip';
import { TitleMatchHistory } from './TitleMatchHistory';
import { KeywordVariantsBox } from './KeywordVariantsBox';
import { WeeklyHistoryTable, HistoryTableSkeleton } from './WeeklyHistoryTable';
import { TopProductsSection, TopProductsSkeleton } from './TopProductsSection';

export const metadata: Metadata = {
  title: 'Keyword detail',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function KeywordDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ from?: string | string[] }>;
}) {
  const timer = startHandlerTimer();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const detail = await fetchKeywordChartData(id);
  timer.mark('chartData (fast loader)');
  if (!detail) notFound();

  const user = await getCurrentUser();
  timer.mark('auth');
  const isWatched = user ? await isKeywordWatched(user.id, id) : false;
  timer.mark('isWatched');

  const sp = searchParams ? await searchParams : {};
  const fromRaw = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  // Only allow same-origin /explorer URLs (defense against open-redirect via from=).
  const backHref = fromRaw && fromRaw.startsWith('/explorer') ? fromRaw : '/explorer';
  // True when we arrived from the explorer, so the back control can restore it
  // instantly via router.back() instead of a cold re-render. (Watchlist and
  // direct entries fall back to a normal link to backHref.)
  const cameFromExplorer = Boolean(fromRaw && fromRaw.startsWith('/explorer'));

  const {
    searchTermRaw,
    searchTermNormalized,
    current,
    chartHistory,
    currentWeekVariants,
  } = detail;

  const showNormalized =
    searchTermNormalized && searchTermNormalized.toLowerCase() !== searchTermRaw.toLowerCase();

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PerfPanel
        admin={user?.role === 'admin'}
        data={{
          totalMs: timer.totalMs(),
          steps: [
            ...timer.steps,
            { label: 'weekly history', ms: 0, note: 'deferred (streams)' },
          ],
        }}
      />
      <BackToExplorer href={backHref} cameFromExplorer={cameFromExplorer} />

      <header className="mt-3 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">&ldquo;{searchTermRaw}&rdquo;</h1>
          {user && <WatchToggle keywordId={id} initialIsWatched={isWatched} />}
        </div>
        {showNormalized && (
          <p className="text-xs text-gray-500 mt-1">Normalized: {searchTermNormalized}</p>
        )}

        {current ? (
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span>
              <span className="text-gray-500">Current rank:</span>{' '}
              <span className="font-mono font-medium">{current.currentRank.toLocaleString()}</span>
            </span>
            {current.estimatedMonthlyVolumeCurrent !== null && (
              <span>
                <span className="text-gray-500">Est. monthly searches:</span>{' '}
                <span
                  className="font-mono font-medium"
                  title={
                    current.estimatedMonthlyVolumeIsExtrapolated
                      ? `${current.estimatedMonthlyVolumeCurrent.toLocaleString()} — estimate uses extrapolated parameters (this week predates the earliest calibration fit)`
                      : `${current.estimatedMonthlyVolumeCurrent.toLocaleString()} — rough estimate from rank → volume calibration fit (typical accuracy ±30%)`
                  }
                >
                  ~{formatHeadlineVolume(current.estimatedMonthlyVolumeCurrent)}
                  {current.estimatedMonthlyVolumeIsExtrapolated && (
                    <span className="ml-1 text-amber-600">*</span>
                  )}
                </span>
              </span>
            )}
            {current.improvement1w !== null && (
              <span>
                <span className="text-gray-500">vs prior week:</span>{' '}
                <ImprovementChip improvement={current.improvement1w} />
              </span>
            )}
            <span className="text-gray-500">
              Latest: {current.currentWeekEndDate}
            </span>
          </div>
        ) : (
          <div className="mt-3 inline-block bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 rounded">
            This keyword is dormant — last seen <strong>{detail.lastSeenWeek}</strong>. The
            history below is preserved; the explorer&apos;s active snapshot has dropped it.
          </div>
        )}
      </header>

      <section className="mt-6">
        <LazyRankChart
          history={chartHistory}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      <section className="mt-6">
        <LazyVolumeChart
          history={chartHistory}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      {current && (
        <Suspense fallback={<TopProductsSkeleton />}>
          <TopProductsSection id={id} currentWeekEndDate={current.currentWeekEndDate} />
        </Suspense>
      )}

      <section className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FakeVolumeStrip
          history={chartHistory}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
        <TitleMatchHistory
          history={chartHistory}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Weekly history</h2>
        <Suspense fallback={<HistoryTableSkeleton />}>
          <WeeklyHistoryTable id={id} />
        </Suspense>
      </section>

      {/* Variants box: only for active keywords whose current week had >1
          raw CSV phrasing. Sourced from the fast loader's current-week
          import_duplicate_search_terms read. */}
      {current && currentWeekVariants && (
        <section className="mt-6">
          <KeywordVariantsBox
            weekEndDate={current.currentWeekEndDate}
            variants={currentWeekVariants}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Header-line volume format. Slightly more legible than the table-cell
 * compact format — uses commas for full numbers, M/K only when really
 * big. The ~ prefix in the header text signals "this is an estimate."
 */
function formatHeadlineVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M / mo`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K / mo`;
  return `${n.toLocaleString()} / mo`;
}

function ImprovementChip({ improvement }: { improvement: number }) {
  if (improvement === 0) return <span className="font-mono">0</span>;
  if (improvement > 0) {
    return (
      <span className="font-mono text-green-700">
        ↑ {improvement.toLocaleString()}
      </span>
    );
  }
  return (
    <span className="font-mono text-red-700">
      ↓ {Math.abs(improvement).toLocaleString()}
    </span>
  );
}
