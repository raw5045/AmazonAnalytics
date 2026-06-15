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
import { notFound } from 'next/navigation';
import { fetchKeywordDetail, type EnrichedProduct } from '@/lib/explorer/fetchKeywordDetail';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { isKeywordWatched } from '@/lib/watchlist/loadServer';
import { WatchToggle } from '@/app/(app)/_components/WatchToggle';
import { BackToExplorer } from './BackToExplorer';
import { RawDataTable } from './RawDataTable';
import { RankChart } from './RankChart';
import { VolumeChart } from './VolumeChart';
import { FakeVolumeStrip } from './FakeVolumeStrip';
import { TitleMatchHistory } from './TitleMatchHistory';
import { KeywordVariantsBox } from './KeywordVariantsBox';

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
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const detail = await fetchKeywordDetail(id);
  if (!detail) notFound();

  const user = await getCurrentUser();
  const isWatched = user ? await isKeywordWatched(user.id, id) : false;

  const sp = searchParams ? await searchParams : {};
  const fromRaw = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  // Only allow same-origin /explorer URLs (defense against open-redirect via from=).
  const backHref = fromRaw && fromRaw.startsWith('/explorer') ? fromRaw : '/explorer';
  // True when we arrived from the explorer, so the back control can restore it
  // instantly via router.back() instead of a cold re-render. (Watchlist and
  // direct entries fall back to a normal link to backHref.)
  const cameFromExplorer = Boolean(fromRaw && fromRaw.startsWith('/explorer'));

  const { searchTermRaw, searchTermNormalized, current, history, enrichedProductsByAsin } = detail;
  const showNormalized =
    searchTermNormalized && searchTermNormalized.toLowerCase() !== searchTermRaw.toLowerCase();

  // Top-clicked products: source the 3 ASINs from the latest history row
  // matching kcs's current_week_end_date. (kcs itself only stores slot 1
  // explicitly; slots 2 + 3 live in kwm.) Only renders for active keywords.
  const currentWeekRow = current
    ? history.find((r) => r.weekEndDate === current.currentWeekEndDate) ?? null
    : null;
  const topClickedSlots: Array<{
    slot: 1 | 2 | 3;
    asin: string | null;
    fallbackTitle: string | null;
    clickShare?: string | null;
    conversionShare?: string | null;
  }> = currentWeekRow
    ? [
        {
          slot: 1,
          asin: currentWeekRow.topClickedProduct1Asin,
          fallbackTitle: currentWeekRow.topClickedProduct1Title,
          clickShare: current?.topClickedProduct1ClickShareCurrent ?? null,
          conversionShare: current?.topClickedProduct1ConversionShareCurrent ?? null,
        },
        {
          slot: 2,
          asin: currentWeekRow.topClickedProduct2Asin,
          fallbackTitle: currentWeekRow.topClickedProduct2Title,
        },
        {
          slot: 3,
          asin: currentWeekRow.topClickedProduct3Asin,
          fallbackTitle: currentWeekRow.topClickedProduct3Title,
        },
      ]
    : [];
  const hasAnyProduct = topClickedSlots.some((s) => s.asin);

  return (
    <div className="p-6 max-w-6xl mx-auto">
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
        <RankChart
          history={history}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      <section className="mt-6">
        <VolumeChart
          history={history}
          latestWeek={current?.currentWeekEndDate ?? detail.lastSeenWeek}
        />
      </section>

      {hasAnyProduct && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Top clicked products</h2>
          <TopProductsTable slots={topClickedSlots} enrichedByAsin={enrichedProductsByAsin} />
        </section>
      )}

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

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Weekly history</h2>
        <RawDataTable rows={history} />
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

interface TopProductSlot {
  slot: 1 | 2 | 3;
  asin: string | null;
  fallbackTitle: string | null;
  clickShare?: string | null;
  conversionShare?: string | null;
}

/**
 * Compact table replacing the old image-heavy ProductCard layout
 * (which was the dominant cause of slow page loads). Shows the three
 * top-clicked products' price, review count + star rating, and
 * leaf category — all from already-fetched Keepa data.
 */
function TopProductsTable({
  slots,
  enrichedByAsin,
}: {
  slots: TopProductSlot[];
  enrichedByAsin: Record<string, EnrichedProduct>;
}) {
  const rows = slots.filter((s): s is TopProductSlot & { asin: string } => !!s.asin);
  return (
    <div className="overflow-x-auto border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
          <tr>
            <th className="p-2 w-8">#</th>
            <th className="p-2">Product</th>
            <th className="p-2 text-right">Price</th>
            <th className="p-2 text-right">Reviews</th>
            <th className="p-2">Leaf category</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((s) => {
            const enriched = enrichedByAsin[s.asin];
            const title = enriched?.title ?? s.fallbackTitle ?? null;
            return (
              <tr key={`${s.slot}-${s.asin}`} className="align-top">
                <td className="p-2 font-mono text-gray-600">{s.slot}</td>
                <td className="p-2 max-w-md">
                  <div className="truncate" title={title ?? undefined}>
                    {title ?? <span className="text-gray-400">—</span>}
                  </div>
                  <div className="text-xs text-gray-500 font-mono">
                    <a
                      href={`https://www.amazon.com/dp/${s.asin}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {s.asin}
                    </a>
                  </div>
                </td>
                <td className="p-2 text-right tabular-nums">
                  {formatPrice(enriched?.currentPriceCents ?? null)}
                </td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">
                  {formatReviews(enriched?.reviewCount ?? null, enriched?.averageRatingX10 ?? null)}
                </td>
                <td className="p-2 text-xs text-gray-700">
                  {enriched?.categoryLeaf ?? enriched?.categoryPath ?? <span className="text-gray-400">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatPrice(cents: number | null): React.ReactNode {
  if (cents === null || !Number.isFinite(cents)) return <span className="text-gray-400">—</span>;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatReviews(count: number | null, ratingX10: number | null): React.ReactNode {
  if (count === null || !Number.isFinite(count)) return <span className="text-gray-400">—</span>;
  const star =
    ratingX10 !== null && Number.isFinite(ratingX10)
      ? <span className="text-yellow-600">★ {(ratingX10 / 10).toFixed(1)}</span>
      : null;
  const reviewStr = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count.toLocaleString();
  return (
    <span>
      {reviewStr}
      {star && <> · {star}</>}
    </span>
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
