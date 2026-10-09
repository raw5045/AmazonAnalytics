'use client';

import type { ReactNode } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { DotItemDotProps, TooltipContentProps } from 'recharts';
import type { HistoryPoint } from '@/lib/products/loadProductHistory';
import { formatBadge, formatPriceCents } from '@/lib/products/format';

/**
 * The ASIN page's snapshot history (spec 2026-10-09 §6.2): four small line charts, price, BSR,
 * reviews and monthly sold, one point per Keepa fetch, oldest first. Loaded only through
 * LazyHistoryCharts (next/dynamic, ssr:false), so recharts stays out of the route's first-load JS.
 *
 * - Points sit one per fetch along the x axis (fetches are roughly evenly spaced), labelled by date.
 * - A null (a fetch that could not read the fact: no price, delisted) is a gap in the line; a point
 *   with gaps on both sides, or a lone snapshot, is drawn as a dot so it is not lost.
 * - BSR runs on an inverted axis: lower is better, so better is up.
 * - A series with no values at all says so instead of drawing empty axes.
 */

/** The fields the charts read. The page sends only these, so the client payload stays small. */
export type ChartPoint = Pick<HistoryPoint, 'fetchedAt' | 'currentPriceCents' | 'salesRank' | 'reviewCount' | 'monthlySold'>;

/** Keep in step with HistorySkeleton (LazyHistoryCharts.tsx), so swapping the charts in causes no layout shift. */
const CHART_HEIGHT = 160;

interface ChartRow {
  /** ISO timestamp of the fetch: the x category (unique per fetch). */
  at: string;
  price: number | null;
  bsr: number | null;
  reviews: number | null;
  sold: number | null;
}

type SeriesKey = Exclude<keyof ChartRow, 'at'>;

interface SeriesSpec {
  key: SeriesKey;
  title: string;
  /** For "No … data in these snapshots". */
  noun: string;
  hint?: string;
  color: string;
  reversed?: boolean;
  formatValue: (v: number) => string;
  formatTick: (v: number) => string;
}

const SERIES: readonly SeriesSpec[] = [
  { key: 'price', title: 'Price ($)', noun: 'price', color: '#16a34a', formatValue: (v) => formatPriceCents(v), formatTick: formatDollarTick },
  {
    key: 'bsr',
    title: 'BSR',
    noun: 'BSR',
    hint: 'lower is better',
    color: '#2563eb',
    reversed: true,
    formatValue: (v) => `#${v.toLocaleString('en-US')}`,
    formatTick: formatCountTick,
  },
  { key: 'reviews', title: 'Reviews', noun: 'review', color: '#d97706', formatValue: (v) => v.toLocaleString('en-US'), formatTick: formatCountTick },
  {
    key: 'sold',
    title: 'Monthly sold',
    noun: 'monthly sold',
    hint: 'Amazon’s badge floor',
    color: '#7c3aed',
    formatValue: (v) => formatBadge(v),
    formatTick: formatCountTick,
  },
];

export function HistoryCharts({ points }: { points: readonly ChartPoint[] }) {
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
  const first = rows[0].at.slice(0, 10);
  const last = rows[rows.length - 1].at.slice(0, 10);
  const summary = rows.length === 1 ? `1 snapshot, ${first}` : `${rows.length.toLocaleString('en-US')} snapshots, ${first} to ${last}`;
  return (
    <HistoryFrame summary={summary}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {SERIES.map((spec) => (
          <SeriesChart key={spec.key} rows={rows} spec={spec} />
        ))}
      </div>
    </HistoryFrame>
  );
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
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
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
        <div className="flex items-center justify-center text-xs text-gray-400" style={{ height: CHART_HEIGHT }}>
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
