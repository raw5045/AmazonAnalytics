import Link from 'next/link';
import type { ExplorerRow, MatchMode, SeverityKey, WindowKey } from '@/lib/explorer/types';

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
  backUrl,
}: {
  rows: ExplorerRow[];
  window: WindowKey;
  matchMode: MatchMode;
  /** The URL the detail page should return to (preserves filter state). */
  backUrl: string;
}) {
  const fromParam = backUrl === '/explorer' ? '' : `?from=${encodeURIComponent(backUrl)}`;
  const inTitle = (r: ExplorerRow, slot: 1 | 2 | 3): boolean | null => {
    if (matchMode === 'loose') {
      return slot === 1 ? r.keywordInTitle1Loose : slot === 2 ? r.keywordInTitle2Loose : r.keywordInTitle3Loose;
    }
    return slot === 1 ? r.keywordInTitle1 : slot === 2 ? r.keywordInTitle2 : r.keywordInTitle3;
  };
  const matchCount = (r: ExplorerRow): number | null =>
    matchMode === 'loose' ? r.keywordTitleMatchCountLoose : r.keywordTitleMatchCount;
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
            <th className="p-2">Search term</th>
            <th className="p-2 text-right">Current rank</th>
            <th
              className="p-2 text-right"
              title="Estimated monthly Amazon search volume, derived from the rank → volume calibration fit. Typical accuracy ±30% (current fit's holdout MAPE). Note: Fresh_Produce keywords are NOT calibrated — those estimates can be wildly off."
            >
              Est. monthly vol.
            </th>
            <th className="p-2 text-right">{WINDOW_LABEL[window]}</th>
            <th className="p-2 text-right">Δ</th>
            <th className="p-2">Category</th>
            <th className="p-2 text-center" title="Fake volume severity">Fake?</th>
            <th className="p-2 text-center w-12" title={`Keyword in title slot 1 (${matchMode} match)`}>In #1</th>
            <th className="p-2 text-center w-12" title={`Keyword in title slot 2 (${matchMode} match)`}>In #2</th>
            <th className="p-2 text-center w-12" title={`Keyword in title slot 3 (${matchMode} match)`}>In #3</th>
            <th className="p-2 text-right" title={`${matchMode} match count`}>Match count</th>
            <th className="p-2">Top product #1</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.searchTermId} className="hover:bg-gray-50">
              <td className="p-2 font-medium">
                <Link
                  href={`/explorer/keyword/${r.searchTermId}${fromParam}`}
                  className="text-blue-700 hover:underline"
                >
                  {r.searchTermRaw}
                </Link>
              </td>
              <td className="p-2 text-right tabular-nums">{r.currentRank.toLocaleString()}</td>
              <td className="p-2 text-right tabular-nums" title={r.estimatedMonthlyVolumeCurrent !== null ? `${r.estimatedMonthlyVolumeCurrent.toLocaleString()} searches / month (est.)` : undefined}>
                {formatVolume(r.estimatedMonthlyVolumeCurrent)}
              </td>
              <td className="p-2 text-right tabular-nums text-gray-600">
                {r.priorRank?.toLocaleString() ?? <span className="text-gray-400">—</span>}
              </td>
              <td className="p-2 text-right tabular-nums">
                {r.improvement !== null ? <DeltaCell value={r.improvement} /> : <span className="text-gray-400">—</span>}
              </td>
              <td className="p-2 text-gray-700">{r.topClickedCategory1 ?? <span className="text-gray-400">—</span>}</td>
              <td className="p-2 text-center"><SeverityBadge severity={r.fakeVolumeSeverity} /></td>
              <td className="p-2 text-center"><TitleIcon present={inTitle(r, 1)} /></td>
              <td className="p-2 text-center"><TitleIcon present={inTitle(r, 2)} /></td>
              <td className="p-2 text-center"><TitleIcon present={inTitle(r, 3)} /></td>
              <td className="p-2 text-right tabular-nums">
                {matchCount(r) ?? <span className="text-gray-400">—</span>}
              </td>
              <td className="p-2 max-w-xs">
                <TopProductCell row={r} />
              </td>
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

function TopProductCell({ row }: { row: ExplorerRow }) {
  if (!row.topClickedProduct1Title) return <span className="text-gray-400">—</span>;
  const click = row.topClickedProduct1ClickShare;
  const conv = row.topClickedProduct1ConversionShare;
  const showShares = click !== null || conv !== null;
  return (
    <span title={row.topClickedProduct1Asin ?? ''}>
      <span className="block truncate" title={row.topClickedProduct1Title}>
        {row.topClickedProduct1Title}
      </span>
      {showShares && (
        <span className="block text-xs text-gray-500 mt-0.5">
          click {fmtPct(click)} · conv {fmtPct(conv)}
        </span>
      )}
    </span>
  );
}

function fmtPct(s: string | null): string {
  if (s === null) return '—';
  const n = parseFloat(s);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
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
