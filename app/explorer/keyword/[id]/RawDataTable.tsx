'use client';

import { useState } from 'react';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

const SEVERITY_COLORS: Record<string, string> = {
  none: 'text-gray-400',
  warning: 'text-orange-600',
  critical: 'text-red-700',
};

/**
 * Full-history table for a single keyword. Most-recent-first per spec.
 * One row per week the term appeared in kwm.
 *
 * The In #1/#2/#3 columns show the LOOSE match (per-week, backfilled
 * in migration 0014). Strict can be viewed in the TitleMatchHistory
 * grid above. We don't surface strict in this table because the
 * primary use of this table is "what happened this week" and loose
 * matches user mental-model better.
 *
 * The Variants column shows how many rows the source CSV had for this
 * (week, keyword). 1 = no duplicates (clean). >1 = the row was
 * deduped at import time; click to see the losing ranks.
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
            <th className="p-2 text-center" title="Loose match — every word in title (#1)">In #1</th>
            <th className="p-2 text-center" title="Loose match — every word in title (#2)">In #2</th>
            <th className="p-2 text-center" title="Loose match — every word in title (#3)">In #3</th>
            <th className="p-2 text-center">Match #</th>
            <th className="p-2">Fake?</th>
            <th className="p-2 text-center" title="Variant rows in source CSV. 1 = clean. >1 = duplicates were deduped at import.">Variants</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {displayRows.map((r) => (
            <Row key={r.weekEndDate} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row: r }: { row: KeywordDetailHistoryRow }) {
  const [expanded, setExpanded] = useState(false);
  const variantCount = r.variants?.duplicateCount ?? 1;
  const canExpand = variantCount > 1;
  return (
    <>
      <tr className="hover:bg-gray-50">
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
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline"
              title="Click to see variant ranks"
            >
              {variantCount}
              <span className="text-xs">{expanded ? '▾' : '▸'}</span>
            </button>
          ) : (
            <span className="text-gray-400">1</span>
          )}
        </td>
      </tr>
      {expanded && r.variants && (
        <tr className="bg-blue-50 border-t border-blue-100">
          <td colSpan={12} className="p-3 text-xs">
            <div className="space-y-1">
              <div className="text-gray-700">
                <strong>{variantCount} variant rows</strong> in the source CSV for this week. We
                kept the lowest rank (above) and dropped the rest.
              </div>
              <div className="font-mono text-gray-600">
                All ranks (sorted ascending):{' '}
                {r.variants.losingRanks.map((rank) => rank.toLocaleString()).join(' · ')}
              </div>
              {r.variants.rawExamples.length > 0 && (
                <div className="text-gray-600">
                  Sample raw values:{' '}
                  {r.variants.rawExamples.map((ex, i) => (
                    <span key={i} className="font-mono">
                      &ldquo;{ex}&rdquo;
                      {i < r.variants!.rawExamples.length - 1 ? ' · ' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
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
