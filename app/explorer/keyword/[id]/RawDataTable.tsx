import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

const SEVERITY_COLORS: Record<string, string> = {
  none: 'text-gray-400',
  warning: 'text-orange-600',
  critical: 'text-red-700',
};

/**
 * Full-history table for a single keyword. Most-recent-first per spec.
 * One row per week the term appeared in kwm. Columns mirror what's in
 * keyword_weekly_metrics for the per-keyword fields the explorer uses.
 */
export function RawDataTable({ rows }: { rows: KeywordDetailHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border rounded p-6 text-sm text-gray-500">
        No history found for this keyword.
      </div>
    );
  }

  // Spec calls for most-recent first; data fetcher returns oldest first
  // (chronological is needed for chart prep), so reverse here for display.
  const displayRows = [...rows].reverse();

  return (
    <div className="overflow-x-auto border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
          <tr>
            <th className="p-2">Week</th>
            <th className="p-2 text-right">Rank</th>
            <th className="p-2">Top product #1</th>
            <th className="p-2 text-right">Click %</th>
            <th className="p-2 text-right">Conv %</th>
            <th className="p-2">Category</th>
            <th className="p-2 text-center">In #1</th>
            <th className="p-2 text-center">In #2</th>
            <th className="p-2 text-center">In #3</th>
            <th className="p-2 text-center">Match #</th>
            <th className="p-2">Fake?</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {displayRows.map((r) => (
            <tr key={r.weekEndDate} className="hover:bg-gray-50">
              <td className="p-2 font-mono text-gray-700 whitespace-nowrap">{r.weekEndDate}</td>
              <td className="p-2 text-right tabular-nums font-mono">{r.actualRank.toLocaleString()}</td>
              <td className="p-2 max-w-xs">
                {r.topClickedProduct1Title ? (
                  <span title={r.topClickedProduct1Asin ?? ''} className="block truncate">
                    {r.topClickedProduct1Title}
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
              <td className="p-2 text-right tabular-nums">{formatPct(r.topClickedProduct1ClickShare)}</td>
              <td className="p-2 text-right tabular-nums">{formatPct(r.topClickedProduct1ConversionShare)}</td>
              <td className="p-2 text-gray-700">{r.topClickedCategory1 ?? <span className="text-gray-400">—</span>}</td>
              <td className="p-2 text-center"><CheckIcon present={r.keywordInTitle1} /></td>
              <td className="p-2 text-center"><CheckIcon present={r.keywordInTitle2} /></td>
              <td className="p-2 text-center"><CheckIcon present={r.keywordInTitle3} /></td>
              <td className="p-2 text-center tabular-nums">
                {r.keywordTitleMatchCount ?? <span className="text-gray-400">—</span>}
              </td>
              <td className={`p-2 ${SEVERITY_COLORS[r.fakeVolumeSeverity ?? 'none']}`}>
                {r.fakeVolumeSeverity ?? <span className="text-gray-400">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckIcon({ present }: { present: boolean | null }) {
  if (present === null) return <span className="text-gray-300">—</span>;
  if (present) return <span className="text-green-700">✓</span>;
  return <span className="text-gray-400">✗</span>;
}

function formatPct(s: string | null): React.ReactNode {
  if (s === null) return <span className="text-gray-400">—</span>;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return <span className="text-gray-400">—</span>;
  return `${n.toFixed(1)}%`;
}
