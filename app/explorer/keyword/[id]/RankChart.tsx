'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import {
  buildWeekCalendar,
  gapFillHistory,
  type GapFilledRow,
} from '@/lib/explorer/formatHistory';

/**
 * 52-week rank trend line. Y-axis is reversed so rank 1 (best) is at
 * the top. Reference lines at well-known rank thresholds give context
 * — a line bouncing between 50k and 100k means "long-tail term," a
 * line consistently under 10k means "head-tier."
 *
 * Gap weeks (term not observed) are emitted as `null` actualRank;
 * recharts' connectNulls={false} renders this as a break in the line.
 */
export function RankChart({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  /** Anchor of the 52-week window. Usually the kcs current_week_end_date. */
  latestWeek: string;
}) {
  const calendar = buildWeekCalendar(latestWeek, 52);
  const data = gapFillHistory(history, calendar);

  // Pick reference lines whose values fall inside the actual data range
  // — otherwise the chart shrinks the data line to make room for an
  // off-screen reference at e.g. rank 500k when all data is sub-10k.
  const ranksObserved = data.map((d) => d.actualRank).filter((r): r is number => r !== null);
  const minRank = ranksObserved.length > 0 ? Math.min(...ranksObserved) : 1;
  const maxRank = ranksObserved.length > 0 ? Math.max(...ranksObserved) : 1_000_000;
  const referenceLines = [10_000, 50_000, 100_000, 500_000].filter(
    (v) => v >= minRank && v <= maxRank,
  );

  return (
    <div className="border rounded p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-700">Rank trend (52w)</h2>
        <p className="text-xs text-gray-500">Lower = more searched. Gaps = unranked weeks.</p>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="weekEndDate"
            tick={{ fontSize: 11 }}
            tickFormatter={formatWeekTick}
            interval={Math.max(0, Math.floor(data.length / 8))}
          />
          <YAxis
            reversed
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => v.toLocaleString()}
            width={70}
          />
          {referenceLines.map((v) => (
            <ReferenceLine
              key={v}
              y={v}
              stroke="#9ca3af"
              strokeDasharray="2 4"
              label={{
                value: formatRefLabel(v),
                fill: '#6b7280',
                fontSize: 10,
                position: 'right',
              }}
            />
          ))}
          <Tooltip content={RankTooltip} />
          <Line
            dataKey="actualRank"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RankTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = (payload[0] as { payload: GapFilledRow }).payload;
  if (datum.actualRank === null) {
    return (
      <div className="bg-white border rounded shadow-sm px-3 py-2 text-xs">
        <div className="font-medium">{datum.weekEndDate}</div>
        <div className="text-gray-500 mt-1">unranked</div>
      </div>
    );
  }
  return (
    <div className="bg-white border rounded shadow-sm px-3 py-2 text-xs">
      <div className="font-medium">{datum.weekEndDate}</div>
      <div className="font-mono mt-1">rank {datum.actualRank.toLocaleString()}</div>
      {datum.raw?.fakeVolumeSeverity && datum.raw.fakeVolumeSeverity !== 'none' && (
        <div className="text-gray-500 mt-1 capitalize">{datum.raw.fakeVolumeSeverity} fake-volume</div>
      )}
    </div>
  );
}

function formatWeekTick(v: string): string {
  // YYYY-MM-DD → "MMM DD"
  const [, m, d] = v.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = parseInt(m, 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return v;
  return `${monthNames[monthIndex]} ${parseInt(d, 10)}`;
}

function formatRefLabel(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}k`;
  return String(v);
}
