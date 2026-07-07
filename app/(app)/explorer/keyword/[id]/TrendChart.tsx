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
 * 52-week trend chart with a metric toggle: estimated volume or SFR (rank).
 * Replaces the former back-to-back RankChart + VolumeChart — the two series
 * are near-mirror views of the same signal (volume is derived from rank via
 * the calibration fit), so one card with a toggle says the same thing in
 * half the vertical space.
 *
 * Defaults: volume view, LINEAR scale — for a single keyword's 52-week range
 * linear shows the seasonal swing honestly. SFR view defaults to LOG because
 * rank spans orders of magnitude — a 2M→60K move is invisible on a linear
 * axis. Each metric remembers its own scale choice while the page is open.
 *
 * SFR view: Y-axis is reversed so rank 1 (best) is at the top.
 * Volume view: weeks whose fit was extrapolated (predate calibration) render
 * as hollow grey dots and say so in the tooltip.
 * Gap weeks (term not observed) are `null`; connectNulls={false} renders
 * them as breaks in the line.
 */

type Metric = 'volume' | 'rank';
type Scale = 'log' | 'linear';

interface VolumePoint {
  weekEndDate: string;
  volume: number | null;
  isExtrapolated: boolean;
}

export function TrendChart({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  /** Anchor of the 52-week window. Usually the kcs current_week_end_date. */
  latestWeek: string;
}) {
  const [metric, setMetric] = useState<Metric>('volume');
  // Per-metric scale memory: flipping SFR to linear and back doesn't reset it.
  const [scaleByMetric, setScaleByMetric] = useState<Record<Metric, Scale>>({
    volume: 'linear',
    rank: 'log',
  });
  const scale = scaleByMetric[metric];
  const setScale = (s: Scale) =>
    setScaleByMetric((prev) => ({ ...prev, [metric]: s }));

  const calendar = buildWeekCalendar(latestWeek, 52);
  const data = gapFillHistory(history, calendar);

  const accent = metric === 'volume' ? 'green' : 'blue';

  return (
    <div className="card-app p-4">
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-2">
        <h2 className="text-sm font-semibold text-gray-700">
          {metric === 'volume' ? 'Est. volume trend (52w)' : 'Rank trend (52w)'}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-gray-500">
            {metric === 'volume'
              ? 'Directional (±~30%). Hollow dot = extrapolated.'
              : 'Lower = more searched. Gaps = unranked weeks.'}
          </p>
          <PillToggle<Metric>
            value={metric}
            onChange={setMetric}
            accent={accent}
            options={[
              { value: 'volume', label: 'Est. volume' },
              { value: 'rank', label: 'SFR' },
            ]}
          />
          <PillToggle<Scale>
            value={scale}
            onChange={setScale}
            accent={accent}
            options={[
              { value: 'log', label: 'Log' },
              { value: 'linear', label: 'Linear' },
            ]}
          />
        </div>
      </div>
      {/* key={metric} forces a clean recharts remount on metric switch — the
          axis config flips (reversed/domain/ticks), which recharts animates
          badly when patched in place. */}
      {metric === 'volume' ? (
        <VolumeBody key="volume" data={data} scale={scale} />
      ) : (
        <RankBody key="rank" data={data} scale={scale} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Volume view
// ---------------------------------------------------------------------------

function VolumeBody({ data, scale }: { data: GapFilledRow[]; scale: Scale }) {
  const points: VolumePoint[] = data.map((d) => ({
    weekEndDate: d.weekEndDate,
    volume: d.raw?.estimatedMonthlyVolume ?? null,
    isExtrapolated: d.raw?.estimatedMonthlyVolumeIsExtrapolated ?? false,
  }));

  const vols = points.map((d) => d.volume).filter((v): v is number => v !== null && v > 0);
  const hasData = vols.length > 0;
  const logLower = hasData ? Math.max(1, Math.floor(Math.min(...vols) * 0.8)) : 1;
  const logUpper = hasData ? Math.ceil(Math.max(...vols) * 1.25) : 1_000;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={points} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="weekEndDate"
          tick={{ fontSize: 11 }}
          tickFormatter={formatWeekTick}
          interval={Math.max(0, Math.floor(points.length / 8))}
        />
        <YAxis
          scale={scale === 'log' ? 'log' : 'linear'}
          domain={scale === 'log' ? [logLower, logUpper] : ['auto', 'auto']}
          allowDataOverflow={false}
          tick={{ fontSize: 11 }}
          tickFormatter={formatCountTick}
          width={70}
        />
        <Tooltip content={VolumeTooltip} />
        <Line
          dataKey="volume"
          stroke="#16a34a"
          strokeWidth={2}
          dot={<VolumeDot />}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function VolumeDot(props: { cx?: number; cy?: number; payload?: VolumePoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload || payload.volume == null) return null;
  return payload.isExtrapolated
    ? <circle cx={cx} cy={cy} r={2.5} fill="white" stroke="#9ca3af" strokeWidth={1} />
    : <circle cx={cx} cy={cy} r={2} fill="#16a34a" />;
}

function VolumeTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = (payload[0] as { payload: VolumePoint }).payload;
  if (datum.volume === null) {
    return (
      <div className="bg-white border rounded shadow-sm px-3 py-2 text-xs">
        <div className="font-medium">{datum.weekEndDate}</div>
        <div className="text-gray-500 mt-1">no estimate</div>
      </div>
    );
  }
  return (
    <div className="bg-white border rounded shadow-sm px-3 py-2 text-xs">
      <div className="font-medium">{datum.weekEndDate}</div>
      <div className="font-mono mt-1">~{datum.volume.toLocaleString()} / mo</div>
      {datum.isExtrapolated && <div className="text-gray-500 mt-1">extrapolated (predates calibration)</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SFR (rank) view
// ---------------------------------------------------------------------------

function RankBody({ data, scale }: { data: GapFilledRow[]; scale: Scale }) {
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
  // padding rather than forcing the top at rank 1 — forcing 1 wastes
  // most of the chart on empty decades for keywords that live at 50K+.
  const logDomainLower = ranksObserved.length > 0 ? Math.max(1, Math.floor(minRank * 0.8)) : 1;
  const logDomainUpper = ranksObserved.length > 0 ? Math.ceil(maxRank * 1.25) : 1_000_000;
  const logTicks = computeLogTicks(logDomainLower, logDomainUpper);

  return (
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
          tickFormatter={formatCountTick}
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

// ---------------------------------------------------------------------------
// Shared controls + formatters
// ---------------------------------------------------------------------------

function PillToggle<T extends string>({
  value,
  onChange,
  options,
  accent,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  accent: 'blue' | 'green';
}) {
  const activeClass = accent === 'green' ? 'bg-green-600 text-white' : 'bg-blue-600 text-white';
  return (
    <div className="inline-flex rounded border border-gray-200 overflow-hidden text-xs">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`px-2 py-0.5 ${i > 0 ? 'border-l border-gray-200' : ''} ${
            value === opt.value ? activeClass : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          {opt.label}
        </button>
      ))}
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

/** Axis tick for counts (volume) and ranks: 1.2M / 45k / 812. */
function formatCountTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return v.toLocaleString();
}

/**
 * Tick set for the log-scale rank axis. Guarantees the top and bottom
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

function formatRefLabel(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}k`;
  return String(v);
}
