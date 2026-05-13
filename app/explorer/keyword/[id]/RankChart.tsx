'use client';

import { useState } from 'react';
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
 * 52-week rank trend line.
 *
 * Y-axis is reversed so rank 1 (best) is at the top.
 *
 * Defaults to LOG scale because rank distribution is heavily non-linear
 * — a move from 2M to 60K is functionally huge but visually invisible
 * on a linear axis (compressed into the bottom 3% of the chart),
 * whereas a move from 100 to 10 (also a huge improvement) is visible
 * but barely. Log scale makes proportional rank changes visible across
 * the whole range. A toggle lets users switch back to linear if they
 * prefer that view.
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
  const [scale, setScale] = useState<'log' | 'linear'>('log');
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

  // Log-scale domain: anchor to the actual data range with a little
  // padding rather than forcing the top at rank 1. Forcing 1 means
  // wasting most of the chart on empty decades — e.g. a keyword that
  // moves 50K → 500K would have its entire line squished into the
  // bottom 25% of the chart with the rest blank. With data-driven
  // bounds the visible chart matches the visible data.
  const logDomainLower = ranksObserved.length > 0 ? Math.max(1, Math.floor(minRank * 0.8)) : 1;
  const logDomainUpper = ranksObserved.length > 0 ? Math.ceil(maxRank * 1.25) : 1_000_000;

  // Log scale ticks: always label the top + bottom of the visible
  // range, plus any decade boundaries (1, 10, 100, 1k, 10k, …) that
  // fall inside it. For tightly-ranged keywords with no decade in
  // range (e.g. always 90k–130k), also include the geometric midpoint
  // so the user always sees at least 3 labels.
  const logTicks = computeLogTicks(logDomainLower, logDomainUpper);

  return (
    <div className="border rounded p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-700">Rank trend (52w)</h2>
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-500">Lower = more searched. Gaps = unranked weeks.</p>
          <ScaleToggle scale={scale} onChange={setScale} />
        </div>
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
            scale={scale === 'log' ? 'log' : 'linear'}
            domain={scale === 'log' ? [logDomainLower, logDomainUpper] : ['auto', 'auto']}
            ticks={scale === 'log' ? logTicks : undefined}
            allowDataOverflow={false}
            tick={{ fontSize: 11 }}
            tickFormatter={formatRankTick}
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

function ScaleToggle({
  scale,
  onChange,
}: {
  scale: 'log' | 'linear';
  onChange: (s: 'log' | 'linear') => void;
}) {
  return (
    <div className="inline-flex rounded border border-gray-200 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => onChange('log')}
        className={`px-2 py-0.5 ${scale === 'log' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
        aria-pressed={scale === 'log'}
      >
        Log
      </button>
      <button
        type="button"
        onClick={() => onChange('linear')}
        className={`px-2 py-0.5 border-l border-gray-200 ${scale === 'linear' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
        aria-pressed={scale === 'linear'}
      >
        Linear
      </button>
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

/**
 * Tick set for the log-scale Y axis. Guarantees the top and bottom
 * of the visible domain are always labeled, includes decade
 * boundaries (1, 10, 100, 1k, …) in between, and falls back to a
 * geometric midpoint if a tight range has no decades.
 */
function computeLogTicks(lower: number, upper: number): number[] {
  const decades = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];
  const ticks = new Set<number>([lower, upper]);
  for (const d of decades) {
    if (d > lower && d < upper) ticks.add(d);
  }
  // For tight ranges with no decade between lower and upper, add the
  // geometric midpoint so the user always sees at least 3 labels.
  // Skip when the range is so tight that a third tick would clutter.
  if (ticks.size < 3 && upper / lower > 1.05) {
    ticks.add(Math.round(Math.sqrt(lower * upper)));
  }
  return Array.from(ticks).sort((a, b) => a - b);
}

function formatRankTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return v.toLocaleString();
}

function formatRefLabel(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}k`;
  return String(v);
}
