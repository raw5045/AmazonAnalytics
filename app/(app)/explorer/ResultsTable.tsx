import Link from 'next/link';
import type { ExplorerRow, MatchMode, SeverityKey, SortKey, WindowKey } from '@/lib/explorer/types';
import { SortableHeader } from './SortableHeader';
import { WatchStar } from '@/app/(app)/_components/WatchStar';

const WINDOW_LABEL: Record<WindowKey, string> = {
  '1w': 'Prior week rank',
  '4w': 'Rank 4w ago',
  '13w': 'Rank 13w ago',
  '26w': 'Rank 26w ago',
  '52w': 'Rank 52w ago',
};

export function ResultsTable({
  rows,
  window,
  matchMode,
  currentSort,
  backUrl,
  watchedKeywordIds,
  showWatchColumn = false,
  addedAtByKeyword,
  onWatchStarToggle,
}: {
  rows: ExplorerRow[];
  window: WindowKey;
  matchMode: MatchMode;
  /** Current sort key — drives the SortableHeader chevrons. */
  currentSort: SortKey;
  /** The URL the detail page should return to (preserves filter state). */
  backUrl: string;
  /** IDs the current user is watching. Used to render ★ vs ☆. */
  watchedKeywordIds?: Set<string>;
  /** When true, the ⭐ column is rendered (hidden for guests). */
  showWatchColumn?: boolean;
  /** When present, render an "Added" column showing time since added. */
  addedAtByKeyword?: Map<string, string>;
  /** Called when the ⭐ in any row is toggled. Used by /watchlist to animate-remove. */
  onWatchStarToggle?: (keywordId: string, isNowWatched: boolean) => void;
}) {
  // Always carry `from` so the detail page can tell it was reached from the
  // explorer (even the default, unfiltered view) and restore it instantly via
  // router.back() instead of a cold re-render. See BackToExplorer.
  const fromParam = `?from=${encodeURIComponent(backUrl)}`;
  const inTitle = (r: ExplorerRow, slot: 1 | 2 | 3): boolean | null => {
    if (matchMode === 'loose') {
      return slot === 1 ? r.keywordInTitle1Loose : slot === 2 ? r.keywordInTitle2Loose : r.keywordInTitle3Loose;
    }
    return slot === 1 ? r.keywordInTitle1 : slot === 2 ? r.keywordInTitle2 : r.keywordInTitle3;
  };
  if (rows.length === 0) {
    return (
      <div className="border rounded p-8 text-center text-sm text-gray-500">
        No keywords match these filters. Try removing one to broaden the search.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
          <tr>
            {showWatchColumn && (
              <th className="p-2 w-8 text-center" title="Click to add/remove from watchlist">
                <span aria-label="Watched">☆</span>
              </th>
            )}
            <th className="p-2">Search term</th>
            <SortableHeader
              label="Current rank"
              ascKey="rank"
              descKey="rank_desc"
              firstClickKey="rank"
              currentSort={currentSort}
              align="right"
              title="Click to sort by current rank. Lower rank = more search volume."
            />
            <th className="p-2 text-right">{WINDOW_LABEL[window]}</th>
            <SortableHeader
              label="Δ"
              ascKey="decline"
              descKey="imp"
              firstClickKey="imp"
              currentSort={currentSort}
              align="right"
              title="Click to sort by improvement in the selected window. First click shows biggest improvements first."
            />
            <th
              className="p-2 text-right"
              title="Estimated monthly Amazon search volume, derived from the rank → volume calibration fit. Typical accuracy ±30% (current fit's holdout MAPE). Note: Fresh_Produce keywords are NOT calibrated — those estimates can be wildly off. (Sort by Current rank for the equivalent volume order.)"
            >
              Est. monthly vol.
            </th>
            <SortableHeader
              label="Avg price"
              ascKey="avg_price_asc"
              descKey="avg_price_desc"
              firstClickKey="avg_price_asc"
              currentSort={currentSort}
              align="right"
              title="Mean price across the top-3 clicked products. Click to sort — first click shows cheapest first."
            />
            <SortableHeader
              label="Avg reviews"
              ascKey="avg_reviews_asc"
              descKey="avg_reviews_desc"
              firstClickKey="avg_reviews_desc"
              currentSort={currentSort}
              align="right"
              title="Mean review count across the top-3 clicked products. Click to sort — first click shows most-reviewed first."
            />
            <th className="p-2" title="Top clicked category #1 (broad)">Category</th>
            <th className="p-2" title="Keepa leaf category for the slot-1 ASIN">Leaf category</th>
            <th className="p-2 text-center" title="Fake volume severity">Fake?</th>
            <th className="p-2 text-center w-12" title={`Keyword in title slot 1 (${matchMode} match)`}>In #1</th>
            <th className="p-2 text-center w-12" title={`Keyword in title slot 2 (${matchMode} match)`}>In #2</th>
            <th className="p-2 text-center w-12" title={`Keyword in title slot 3 (${matchMode} match)`}>In #3</th>
            {addedAtByKeyword && (
              <SortableHeader
                label="Added"
                ascKey="added_asc"
                descKey="added_desc"
                firstClickKey="added_desc"
                currentSort={currentSort}
                align="right"
                title="When you added this keyword to the watchlist"
              />
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.searchTermId} className="hover:bg-gray-50">
              {showWatchColumn && (
                // No onClick stopPropagation here — ResultsTable is a server
                // component, so passing an event handler to a native element
                // would throw "Event handlers cannot be passed to Client
                // Component props" at render time. WatchStar handles
                // stopPropagation + preventDefault internally (see
                // app/(app)/_components/WatchStar.tsx).
                <td className="p-2 text-center">
                  <WatchStar
                    keywordId={r.searchTermId}
                    initialIsWatched={Boolean(watchedKeywordIds?.has(r.searchTermId))}
                    onToggleSuccess={
                      onWatchStarToggle
                        ? (isNowWatched) => onWatchStarToggle(r.searchTermId, isNowWatched)
                        : undefined
                    }
                  />
                </td>
              )}
              <td className="p-2 font-medium">
                <Link
                  href={`/explorer/keyword/${r.searchTermId}${fromParam}`}
                  className="text-blue-700 hover:underline"
                >
                  {r.searchTermRaw}
                </Link>
              </td>
              <td className="p-2 text-right tabular-nums">{r.currentRank.toLocaleString()}</td>
              <td className="p-2 text-right tabular-nums text-gray-600">
                {r.priorRank?.toLocaleString() ?? <span className="text-gray-400">—</span>}
              </td>
              <td className="p-2 text-right tabular-nums">
                {r.improvement !== null ? <DeltaCell value={r.improvement} /> : <span className="text-gray-400">—</span>}
              </td>
              <td className="p-2 text-right tabular-nums" title={r.estimatedMonthlyVolumeCurrent !== null ? `${r.estimatedMonthlyVolumeCurrent.toLocaleString()} searches / month (est.)` : undefined}>
                {formatVolume(r.estimatedMonthlyVolumeCurrent)}
              </td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">
                {formatAvgPrice(r.avgPriceCents)}
              </td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">
                {formatAvgReviews(r.avgReviews)}
              </td>
              <td className="p-2 text-gray-700">{r.topClickedCategory1 ?? <span className="text-gray-400">—</span>}</td>
              <td className="p-2 text-gray-700 text-xs max-w-xs truncate" title={r.topClickedLeafCategory ?? undefined}>
                {r.topClickedLeafCategory ?? <span className="text-gray-400">—</span>}
              </td>
              <td className="p-2 text-center"><SeverityBadge severity={r.fakeVolumeSeverity} /></td>
              <td className="p-2 text-center"><TitleIcon present={inTitle(r, 1)} /></td>
              <td className="p-2 text-center"><TitleIcon present={inTitle(r, 2)} /></td>
              <td className="p-2 text-center"><TitleIcon present={inTitle(r, 3)} /></td>
              {addedAtByKeyword && (
                <td className="p-2 text-right text-xs text-gray-600">
                  {formatRelativeTime(addedAtByKeyword.get(r.searchTermId))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeltaCell({ value }: { value: number }) {
  if (value === 0) return <span className="text-gray-500">0</span>;
  if (value > 0) return <span className="text-green-700">+{value.toLocaleString()}</span>;
  return <span className="text-red-700">{value.toLocaleString()}</span>;
}

function SeverityBadge({ severity }: { severity: SeverityKey | null }) {
  if (!severity || severity === 'none') return <span className="text-gray-300" aria-label="Clean">—</span>;
  if (severity === 'warning') {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full bg-orange-500"
        title="Warning: possible inflated volume"
        aria-label="Warning"
      />
    );
  }
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full bg-red-600"
      title="Critical: high likelihood of fake volume"
      aria-label="Critical"
    />
  );
}

function TitleIcon({ present }: { present: boolean | null }) {
  if (present === null) return <span className="text-gray-300">—</span>;
  if (present) return <span className="text-green-700" aria-label="Present">✓</span>;
  return <span className="text-gray-400" aria-label="Missing">✗</span>;
}

/**
 * Format an estimated monthly volume for the table cell. Compact (1.2M /
 * 423K / 1,234) so the column stays narrow without losing magnitude.
 * Null renders as a gray em-dash.
 */
function formatVolume(n: number | null): React.ReactNode {
  if (n === null || !Number.isFinite(n)) {
    return <span className="text-gray-400">—</span>;
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatAvgPrice(cents: number | null): React.ReactNode {
  if (cents === null || !Number.isFinite(cents)) {
    return <span className="text-gray-400">—</span>;
  }
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  if (dollars >= 100) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

function formatAvgReviews(n: number | null): React.ReactNode {
  if (n === null || !Number.isFinite(n)) {
    return <span className="text-gray-400">—</span>;
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/**
 * Format an ISO timestamp as a coarse relative time ("today", "3d ago",
 * "2w ago", "5mo ago"). Returns '' for an undefined input.
 *
 * Date.now() in render: ResultsTable runs on the server when used from
 * /explorer (server component) AND inside a client subtree when used
 * from /watchlist (WatchlistTable is 'use client'). Drift between SSR
 * and client hydration is bounded (~ms). The one edge case is a row
 * whose addedAt crosses a bucket boundary (today/yesterday, 6d/1w,
 * etc.) during that gap — React will log a hydration warning but the
 * UI stays correct. Acceptable for v1.
 */
function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  const weeks = Math.floor(diffDays / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(diffDays / 30);
  return `${months}mo ago`;
}
