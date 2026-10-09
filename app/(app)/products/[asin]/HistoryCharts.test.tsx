import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HistoryPoint } from '@/lib/products/loadProductHistory';

import React from 'react';

// Same setup as TrendChart.test.tsx: jsdom has no layout, so ResponsiveContainer would measure
// 0×0 (and needs ResizeObserver); hand the chart a fixed size instead.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  const ResponsiveContainer = ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
    React.cloneElement(children, { width: 600, height: 280 });
  return { ...actual, ResponsiveContainer };
});

import { HistoryCharts } from './HistoryCharts';

function point(fetchedAt: string, over: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    fetchedAt,
    currentPriceCents: 1999,
    salesRank: 1234,
    reviewCount: 1800,
    averageRatingX10: 45,
    monthlySold: 1000,
    newOfferCount: 4,
    fbaOfferCount: 3,
    fbmOfferCount: 1,
    enrichmentStatus: 'active',
    ...over,
  };
}

const CHART_TITLES = ['Price ($)', 'BSR', 'Reviews', 'Monthly sold'];

function surfaces(container: HTMLElement): NodeListOf<SVGSVGElement> {
  return container.querySelectorAll('svg.recharts-surface');
}

describe('HistoryCharts', () => {
  it('three points: four small line charts, one per series', () => {
    const { container } = render(
      <HistoryCharts
        points={[
          point('2026-09-20T06:00:00.000Z'),
          point('2026-09-27T06:00:00.000Z', { salesRank: 900, reviewCount: 1850 }),
          point('2026-10-04T06:00:00.000Z', { currentPriceCents: null, enrichmentStatus: 'no_price' }),
        ]}
      />,
    );
    for (const title of CHART_TITLES) expect(screen.getByText(title)).toBeInTheDocument();
    expect(surfaces(container)).toHaveLength(4);
    expect(container.querySelectorAll('path.recharts-line-curve')).toHaveLength(4);
    expect(screen.getByText('3 snapshots, 2026-09-20 to 2026-10-04')).toBeInTheDocument();
    expect(screen.queryByText('No history yet')).toBeNull();
  });

  it('zero points: "No history yet" and no chart', () => {
    const { container } = render(<HistoryCharts points={[]} />);
    expect(screen.getByText('No history yet')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('one point: each chart draws it as a dot (no line to draw)', () => {
    const { container } = render(<HistoryCharts points={[point('2026-10-04T06:00:00.000Z')]} />);
    expect(surfaces(container)).toHaveLength(4);
    expect(container.querySelectorAll('path.recharts-line-curve')).toHaveLength(0);
    expect(container.querySelectorAll('svg.recharts-surface circle')).toHaveLength(4);
    expect(screen.getByText('1 snapshot, 2026-10-04')).toBeInTheDocument();
  });

  it('a point between two gaps is still drawn as a dot', () => {
    const { container } = render(
      <HistoryCharts
        points={[
          point('2026-09-20T06:00:00.000Z', { currentPriceCents: null }),
          point('2026-09-27T06:00:00.000Z'),
          point('2026-10-04T06:00:00.000Z', { currentPriceCents: null }),
        ]}
      />,
    );
    // Only the price series has the isolated point; the other three draw lines without dots.
    expect(container.querySelectorAll('svg.recharts-surface circle')).toHaveLength(1);
  });

  it('a series with no values in any snapshot says so instead of drawing empty axes', () => {
    const { container } = render(
      <HistoryCharts
        points={[
          point('2026-09-27T06:00:00.000Z', { monthlySold: null }),
          point('2026-10-04T06:00:00.000Z', { monthlySold: null }),
        ]}
      />,
    );
    expect(surfaces(container)).toHaveLength(3);
    expect(screen.getByText('No monthly sold data in these snapshots')).toBeInTheDocument();
  });
});
