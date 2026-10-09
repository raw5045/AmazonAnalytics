'use client';

import type { ReactNode } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { DotItemDotProps, TooltipContentProps } from 'recharts';
import { formatBadge, formatPriceCents } from '@/lib/products/format';
import { HISTORY_CHART_HEIGHT, HISTORY_SERIES, type ChartPoint, type HistorySeriesKey } from './chartMeta';

/**
 * The ASIN page's snapshot history (spec 2026-10-09 §6.2): four small line charts, price, BSR,
 * reviews and monthly sold, one point per Keepa fetch, oldest first. Loaded only through
 * LazyHistoryCharts (next/dynamic, ssr:false), so recharts stays out of the route's first-load JS.
 *
 * - Points sit one per fetch along the x axis (fetches are roughly evenly spaced), labelled by date.
 * - A null (a fetch that could not read the fact: no price, delisted) is a gap in the line; a point
 *   with gaps on both sides, or a lone snapshot, is drawn as a dot so it is not lost.
 * - BSR runs on a flipped axis: lower is better, so better is up.
 * - A series with no values at all says so instead of drawing empty axes.
 * - `capped`: the loader returned its maximum number of snapshots, so older ones may be left out;
 *   the summary line says so.
 */

interface ChartRow {
  /** ISO timestamp of the fetch: the x category (unique per fetch). */
  at: string;
  price: number | null;
  bsr: number | null;
  reviews: number | null;
  sold: number | null;
}

interface SeriesFormat {
  /** For "No … data in these snapshots". */
  noun: string;
  color: string;
  reversed?: boolean;
  formatValue: (v: number) => string;
  formatTick: (v: number) => string;
}

const FORMAT: Readonly<Record<HistorySeriesKey, SeriesFormat>> = {
  price: { noun: 'price', color: '#16a34a', formatValue: (v) => formatPriceCents(v), formatTick: formatDollarTick },
  bsr: { noun: 'BSR', color: '#2563eb', reversed: true, formatValue: (v) => `#${v.toLocaleString('en-US')}`, formatTick: formatCountTick },
  reviews: { noun: 'review', color: '#d97706', formatValue: (v) => v.toLocaleString('en-US'), formatTick: formatCountTick },
  sold: { noun: 'monthly sold', color: '#7c3aed', formatValue: (v) => formatBadge(v), formatTick: formatCountTick },
};

type SeriesSpec = (typeof HISTORY_SERIES)[number] & SeriesFormat;

const SERIES: readonly SeriesSpec[] = HISTORY_SERIES.map((meta) => ({ ...meta, ...FORMAT[meta.key] }));

export function HistoryCharts({ points, capped = false }: { points: readonly ChartPoint[]; capped?: boolean }) {
  if (points.length === 0) {
    return (
      <HistoryFrame>
        <p className="card-app p-4 text-sm text-gray-500">No history yet</p>
      </HistoryFrame>
    );
  }
  const rows: ChartRow[] = points.map((p) => ({
    at: p.fetchedAt,
    price: p.currentPriceCents,
    bsr: p.salesRank,
    reviews: p.reviewCount,
    sold: p.monthlySold,
  }));
  return (
    <HistoryFrame summary={historySummary(rows, capped)}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {SERIES.map((spec) => (
          <SeriesChart key={spec.key} rows={rows} spec={spec} />
        ))}
      </div>
    </HistoryFrame>
  );
}

/** "37 snapshots, 2026-08-01 to 2026-10-08", "1 snapshot, 2026-10-04", plus a note when the cap was hit. */
function historySummary(rows: ChartRow[], capped: boolean): string {
  const n = rows.length;
  const first = rows[0].at.slice(0, 10);
  const last = rows[n - 1].at.slice(0, 10);
  const span = n === 1 ? `1 snapshot, ${first}` : `${n.toLocaleString('en-US')} snapshots, ${first} to ${last}`;
  return capped ? `${span} (the newest ${n.toLocaleString('en-US')}; older ones are not shown)` : span;
}

function HistoryFrame({ summary, children }: { summary?: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">History</h2>
        {summary && <p className="text-xs text-gray-500">{summary}</p>}
      </div>
      {children}
    </section>
  );
}

function SeriesChart({ rows, spec }: { rows: ChartRow[]; spec: SeriesSpec }) {
  const hasValues = rows.some((r) => r[spec.key] !== null);
  return (
    <div className="card-app min-w-0 p-4">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-gray-700">{spec.title}</h3>
        {spec.hint && <span className="text-xs text-gray-500">{spec.hint}</span>}
      </div>
      {hasValues ? (
        <ResponsiveContainer width="100%" height={HISTORY_CHART_HEIGHT}>
          <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="at" tick={{ fontSize: 10 }} tickFormatter={formatDayTick} minTickGap={24} />
            <YAxis
              reversed={spec.reversed}
              domain={['auto', 'auto']}
              allowDecimals={false}
              tick={{ fontSize: 10 }}
              tickFormatter={spec.formatTick}
              width={56}
            />
            <Tooltip content={<PointTooltip spec={spec} />} />
            <Line
              dataKey={spec.key}
              stroke={spec.color}
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
              dot={(props: DotItemDotProps) => <IsolatedDot {...props} color={spec.color} />}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center text-xs text-gray-400" style={{ height: HISTORY_CHART_HEIGHT }}>
          No {spec.noun} data in these snapshots
        </div>
      )}
    </div>
  );
}

/**
 * A dot only where the line cannot show the point: a value with no value on either side (a lone
 * snapshot, or one between two gaps). Elsewhere the line itself carries the point.
 */
function IsolatedDot({ cx, cy, index, points, color }: DotItemDotProps & { color: string }) {
  if (cx == null || cy == null) return null;
  const hasNeighbour = (i: number) => points[i] != null && points[i].y != null;
  if (hasNeighbour(index - 1) || hasNeighbour(index + 1)) return null;
  return <circle cx={cx} cy={cy} r={3} fill={color} />;
}

function PointTooltip({ active, payload, spec }: Partial<TooltipContentProps> & { spec: SeriesSpec }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = (payload[0] as { payload: ChartRow }).payload;
  const value = row[spec.key];
  return (
    <div className="rounded border bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium">{formatFetchTime(row.at)}</div>
      <div className="mt-1 font-mono">{value === null ? 'no value' : spec.formatValue(value)}</div>
    </div>
  );
}

/** ISO timestamp → "2026-10-04 06:00 UTC". */
function formatFetchTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO timestamp → "Oct 4" (its UTC date). */
function formatDayTick(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[1]) - 1];
  return month ? `${month} ${Number(m[2])}` : iso;
}

/** Cents → "$18.50" under $100, "$120" from there. */
function formatDollarTick(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 100 ? `$${Math.round(dollars).toLocaleString('en-US')}` : `$${dollars.toFixed(2)}`;
}

/** Axis tick for counts and ranks: 1.2M / 45k / 812 (as the keyword page's TrendChart). */
function formatCountTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return v.toLocaleString('en-US');
}
