'use client';

import { useState } from 'react';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

const SEVERITY_COLORS: Record<string, string> = {
  none: 'text-gray-400',
  warning: 'text-orange-600',
  critical: 'text-red-700',
};

const DEFAULT_ROWS_SHOWN = 2;

/**
 * Full-history table for a single keyword. Most-recent-first per spec.
 * One row per week the term appeared in kwm.
 *
 * Defaults to showing the 2 most recent weeks. A "Show all N weeks" button
 * expands to the full history.
 *
 * Columns:
 *   - In #1/#2/#3 — LOOSE match (per-week; bidirectional plural matcher).
 *     Strict can still be inspected in the TitleMatchHistory grid above.
 *   - Variants — count of raw CSV rows that mapped to this normalized term
 *     for this week. 1 = clean. >1 = duplicates were deduped at import.
 *     Just a count badge; the rich variant breakdown lives in the
 *     "Keyword variants" box above (current week only).
 */
export function RawDataTable({ rows }: { rows: KeywordDetailHistoryRow[] }) {
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return (
      <div className="card-app p-6 text-sm text-gray-500">
        No history found for this keyword.
      </div>
    );
  }

  // Spec calls for most-recent first; data fetcher returns oldest first
  // (chronological is needed for chart prep), so reverse here for display.
  const allRows = [...rows].reverse();
  const visibleRows = expanded ? allRows : allRows.slice(0, DEFAULT_ROWS_SHOWN);
  const hiddenCount = allRows.length - visibleRows.length;

  return (
    <div className="card-app overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
            <tr>
              <th className="p-2">Week</th>
              <th className="p-2 text-right">Rank</th>
              <th
                className="p-2 text-right"
                title="Estimated monthly Amazon search volume for this specific week, computed from the rank → volume calibration fit that covers this week's month. Typical accuracy ±30% on current fit. Note: Fresh_Produce keywords are not calibrated (their estimates can be wildly off)."
              >
                Est. monthly vol.
              </th>
              <th className="p-2">Top product #1</th>
              <th className="p-2 font-mono">ASIN</th>
              <th className="p-2 text-right">Click %</th>
              <th className="p-2 text-right">Conv %</th>
              <th className="p-2">Category</th>
              <th className="p-2 text-center" title="Loose match — every word in title (#1)">In #1</th>
              <th className="p-2 text-center" title="Loose match — every word in title (#2)">In #2</th>
              <th className="p-2 text-center" title="Loose match — every word in title (#3)">In #3</th>
              <th className="p-2 text-center">Match #</th>
              <th className="p-2">Fake?</th>
              <th className="p-2 text-center" title="Variant rows in source CSV for this week. 1 = clean. >1 = duplicates were deduped at import.">Variants</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visibleRows.map((r) => (
              <Row key={r.weekEndDate} row={r} />
            ))}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full p-2 text-sm text-blue-700 hover:bg-blue-50 border-t"
        >
          Show all {allRows.length} weeks (+{hiddenCount} hidden)
        </button>
      ) : (
        allRows.length > DEFAULT_ROWS_SHOWN && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="w-full p-2 text-sm text-gray-600 hover:bg-gray-50 border-t"
          >
            Collapse to {DEFAULT_ROWS_SHOWN} most recent
          </button>
        )
      )}
    </div>
  );
}

function Row({ row: r }: { row: KeywordDetailHistoryRow }) {
  const variantCount = r.variants?.duplicateCount ?? 1;
  return (
    <tr className="hover:bg-gray-50">
      <td className="p-2 font-mono text-gray-700 whitespace-nowrap">{r.weekEndDate}</td>
      <td className="p-2 text-right tabular-nums font-mono">{r.actualRank.toLocaleString()}</td>
      <td
        className="p-2 text-right tabular-nums"
        title={
          r.estimatedMonthlyVolume === null
            ? undefined
            : r.estimatedMonthlyVolumeIsExtrapolated
              ? `${r.estimatedMonthlyVolume.toLocaleString()} searches / month — estimate uses extrapolated parameters (this week predates the earliest calibration fit)`
              : `${r.estimatedMonthlyVolume.toLocaleString()} searches / month (est.)`
        }
      >
        {formatVolume(r.estimatedMonthlyVolume)}
        {r.estimatedMonthlyVolume !== null && r.estimatedMonthlyVolumeIsExtrapolated && (
          <span className="ml-1 text-amber-600" aria-label="extrapolated">*</span>
        )}
      </td>
      <td className="p-2 max-w-xs">
        {r.topClickedProduct1Title ? (
          <span title={r.topClickedProduct1Title} className="block truncate">
            {r.topClickedProduct1Title}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="p-2 font-mono text-xs text-gray-700 whitespace-nowrap">
        {r.topClickedProduct1Asin ?? <span className="text-gray-400">—</span>}
      </td>
      <td className="p-2 text-right tabular-nums">{formatPct(r.topClickedProduct1ClickShare)}</td>
      <td className="p-2 text-right tabular-nums">{formatPct(r.topClickedProduct1ConversionShare)}</td>
      <td className="p-2 text-gray-700">{r.topClickedCategory1 ?? <span className="text-gray-400">—</span>}</td>
      <td className="p-2 text-center"><CheckIcon present={r.keywordInTitle1Loose} /></td>
      <td className="p-2 text-center"><CheckIcon present={r.keywordInTitle2Loose} /></td>
      <td className="p-2 text-center"><CheckIcon present={r.keywordInTitle3Loose} /></td>
      <td className="p-2 text-center tabular-nums">
        {r.keywordTitleMatchCountLoose ?? <span className="text-gray-400">—</span>}
      </td>
      <td className={`p-2 ${SEVERITY_COLORS[r.fakeVolumeSeverity ?? 'none']}`}>
        {r.fakeVolumeSeverity ?? <span className="text-gray-400">—</span>}
      </td>
      <td className="p-2 text-center tabular-nums">
        {variantCount > 1 ? (
          <span className="font-medium text-gray-700">{variantCount}</span>
        ) : (
          <span className="text-gray-400">1</span>
        )}
      </td>
    </tr>
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

/** Compact display: 1.2M / 423K / 1,234. Null → gray em-dash. */
function formatVolume(n: number | null): React.ReactNode {
  if (n === null || !Number.isFinite(n)) {
    return <span className="text-gray-400">—</span>;
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
