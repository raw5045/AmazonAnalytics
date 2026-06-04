'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import { buildWeekCalendar, gapFillHistory } from '@/lib/explorer/formatHistory';

interface VolumePoint {
  weekEndDate: string;
  volume: number | null;
  isExtrapolated: boolean;
}

/**
 * 52-week estimated-volume trend. Mirrors RankChart but the axis is
 * NOT reversed (higher volume = up). Volumes are directional estimates;
 * weeks whose fit was extrapolated (predate calibration) render as
 * hollow grey dots and say so in the tooltip.
 */
export function VolumeChart({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  latestWeek: string;
}) {
  const [scale, setScale] = useState<'log' | 'linear'>('log');
  const calendar = buildWeekCalendar(latestWeek, 52);
  const data: VolumePoint[] = gapFillHistory(history, calendar).map((d) => ({
    weekEndDate: d.weekEndDate,
    volume: d.raw?.estimatedMonthlyVolume ?? null,
    isExtrapolated: d.raw?.estimatedMonthlyVolumeIsExtrapolated ?? false,
  }));

  const vols = data.map((d) => d.volume).filter((v): v is number => v !== null && v > 0);
  const hasData = vols.length > 0;
  const logLower = hasData ? Math.max(1, Math.floor(Math.min(...vols) * 0.8)) : 1;
  const logUpper = hasData ? Math.ceil(Math.max(...vols) * 1.25) : 1_000;

  return (
    <div className="border rounded p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-700">Est. volume trend (52w)</h2>
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-500">Directional (±~30%). Hollow dot = extrapolated.</p>
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
            scale={scale === 'log' ? 'log' : 'linear'}
            domain={scale === 'log' ? [logLower, logUpper] : ['auto', 'auto']}
            allowDataOverflow={false}
            tick={{ fontSize: 11 }}
            tickFormatter={formatVolTick}
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
    </div>
  );
}

function VolumeDot(props: { cx?: number; cy?: number; payload?: VolumePoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload || payload.volume == null) return null;
  return payload.isExtrapolated
    ? <circle cx={cx} cy={cy} r={2.5} fill="white" stroke="#9ca3af" strokeWidth={1} />
    : <circle cx={cx} cy={cy} r={2} fill="#16a34a" />;
}

function ScaleToggle({ scale, onChange }: { scale: 'log' | 'linear'; onChange: (s: 'log' | 'linear') => void }) {
  return (
    <div className="inline-flex rounded border border-gray-200 overflow-hidden text-xs">
      <button type="button" onClick={() => onChange('log')} aria-pressed={scale === 'log'}
        className={`px-2 py-0.5 ${scale === 'log' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>Log</button>
      <button type="button" onClick={() => onChange('linear')} aria-pressed={scale === 'linear'}
        className={`px-2 py-0.5 border-l border-gray-200 ${scale === 'linear' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>Linear</button>
    </div>
  );
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

function formatWeekTick(v: string): string {
  const [, m, d] = v.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = parseInt(m, 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return v;
  return `${monthNames[monthIndex]} ${parseInt(d, 10)}`;
}

function formatVolTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return v.toLocaleString();
}
