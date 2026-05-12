/**
 * /explorer/keyword/<id> — keyword detail page (Plan 3.3).
 *
 * Server component:
 *   1. Validate the [id] param looks like a UUID (cheap 404 path)
 *   2. Fetch search_term + kcs current + kwm history in parallel
 *   3. Render header, charts, timelines, and the raw data table
 *
 * For Commit 2 (this commit) only the header + raw data table render.
 * Subsequent commits add RankChart, FakeVolumeStrip, etc.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchKeywordDetail } from '@/lib/explorer/fetchKeywordDetail';
import { RawDataTable } from './RawDataTable';
import { RankChart } from './RankChart';
import { FakeVolumeStrip } from './FakeVolumeStrip';
import { TitleMatchHistory } from './TitleMatchHistory';
import { KeywordVariantsBox } from './KeywordVariantsBox';

export const metadata: Metadata = {
  title: 'Keyword detail',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function KeywordDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const detail = await fetchKeywordDetail(id);
  if (!detail) notFound();

  const { searchTermRaw, searchTermNormalized, current, history } = detail;
  const showNormalized =
    searchTermNormalized && searchTermNormalized.toLowerCase() !== searchTermRaw.toLowerCase();

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link href="/explorer" className="text-sm underline text-gray-600 hover:text-gray-900">
        ← Back to explorer
      </Link>

      <header className="mt-3 mb-6">
        <h1 className="text-2xl font-semibold">&ldquo;{searchTermRaw}&rdquo;</h1>
        {showNormalized && (
          <p className="text-xs text-gray-500 mt-1">Normalized: {searchTermNormalized}</p>
        )}

        {current ? (
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span>
              <span className="text-gray-500">Current rank:</span>{' '}
              <span className="font-mono font-medium">{current.currentRank.toLocaleString()}</span>
            </span>
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
        <RankChart
          history={history}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      <section className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FakeVolumeStrip
          history={history}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
        <TitleMatchHistory
          history={history}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      {(() => {
        // Variants box: only show for active keywords whose most recent week
        // had >1 raw CSV phrasing for this normalized term.
        if (!current) return null;
        const latestRow = history.find((r) => r.weekEndDate === current.currentWeekEndDate);
        if (!latestRow?.variants) return null;
        return (
          <section className="mt-6">
            <KeywordVariantsBox weekEndDate={current.currentWeekEndDate} variants={latestRow.variants} />
          </section>
        );
      })()}

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Weekly history</h2>
        <RawDataTable rows={history} />
      </section>
    </div>
  );
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
