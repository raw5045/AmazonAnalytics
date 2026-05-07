import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import { groupTopProductRuns } from '@/lib/explorer/formatHistory';

/**
 * Chronological list of "runs" — periods where the same ASIN held the
 * top product slot 1. Most recent first per spec.
 *
 * Each row shows: date range, weeks held, ASIN, title, avg click %,
 * avg conversion %.
 */
export function TopProductTimeline({ history }: { history: KeywordDetailHistoryRow[] }) {
  const runs = groupTopProductRuns(history);
  if (runs.length === 0) {
    return null;
  }

  // Most-recent first
  const display = [...runs].reverse();

  return (
    <div className="border rounded p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Top product #1 — change history</h2>
      <p className="text-xs text-gray-500 mb-3">
        Each row is a continuous run of weeks where one ASIN held the top spot. {display.length}{' '}
        run{display.length === 1 ? '' : 's'} in this keyword&apos;s history.
      </p>
      <ol className="space-y-2">
        {display.map((run, i) => (
          <li
            key={`${run.startWeek}-${run.asin}`}
            className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 p-2 rounded hover:bg-gray-50"
          >
            <div className="text-xs text-gray-600 font-mono w-full md:w-48 shrink-0 whitespace-nowrap">
              {run.startWeek} → {run.endWeek}
              <span className="ml-2 text-gray-400">({run.weeks}w)</span>
              {i === 0 && (
                <span className="ml-2 inline-block bg-blue-100 text-blue-800 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded">
                  current
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate" title={run.title ?? ''}>
                {run.title ?? <span className="text-gray-400">(no title)</span>}
              </div>
              <div className="text-xs text-gray-500 font-mono mt-0.5">{run.asin}</div>
            </div>
            <div className="text-xs text-gray-600 whitespace-nowrap">
              click {fmtPct(run.avgClickShare)} · conv {fmtPct(run.avgConversionShare)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(1)}%`;
}
