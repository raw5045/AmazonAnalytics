import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TrendChart } from './TrendChart';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

import React from 'react';

vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  const ResponsiveContainer = ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
    React.cloneElement(children, { width: 600, height: 280 });
  return { ...actual, ResponsiveContainer };
});

function row(week: string, rank: number, vol: number | null, extrap = false): KeywordDetailHistoryRow {
  return {
    weekEndDate: week, actualRank: rank, topClickedProduct1Asin: null, topClickedProduct1Title: null,
    topClickedProduct1ClickShare: null, topClickedProduct1ConversionShare: null,
    topClickedProduct2Asin: null, topClickedProduct2Title: null, topClickedProduct3Asin: null,
    topClickedProduct3Title: null, topClickedCategory1: null, keywordInTitle1: null, keywordInTitle2: null,
    keywordInTitle3: null, keywordTitleMatchCount: null, keywordInTitle1Loose: null, keywordInTitle2Loose: null,
    keywordInTitle3Loose: null, keywordTitleMatchCountLoose: null, fakeVolumeSeverity: null, fakeVolumeEvalStatus: null,
    estimatedMonthlyVolume: vol, estimatedMonthlyVolumeIsExtrapolated: extrap, variants: null,
  };
}

const history = [
  row('2026-05-16', 120, 1200),
  row('2026-05-23', 90, null),
  row('2026-05-30', 100, 1500, true),
];

function pressed(el: HTMLElement): boolean {
  return el.getAttribute('aria-pressed') === 'true';
}

describe('TrendChart', () => {
  it('defaults to the volume view on a LINEAR scale', () => {
    const { container, getByText, getByRole } = render(
      <TrendChart history={history} latestWeek="2026-05-30" />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(getByText('Est. volume trend (52w)')).toBeTruthy();
    expect(pressed(getByRole('button', { name: 'Est. volume' }))).toBe(true);
    expect(pressed(getByRole('button', { name: 'Linear' }))).toBe(true);
    expect(pressed(getByRole('button', { name: 'Log' }))).toBe(false);
  });

  it('toggles to the SFR view, which defaults to LOG', () => {
    const { container, getByText, getByRole } = render(
      <TrendChart history={history} latestWeek="2026-05-30" />,
    );
    fireEvent.click(getByRole('button', { name: 'SFR' }));
    expect(container.querySelector('svg')).not.toBeNull();
    expect(getByText('Rank trend (52w)')).toBeTruthy();
    expect(pressed(getByRole('button', { name: 'SFR' }))).toBe(true);
    expect(pressed(getByRole('button', { name: 'Log' }))).toBe(true);
  });

  it('remembers each metric’s scale choice independently', () => {
    const { getByRole } = render(<TrendChart history={history} latestWeek="2026-05-30" />);
    // Flip SFR to linear…
    fireEvent.click(getByRole('button', { name: 'SFR' }));
    fireEvent.click(getByRole('button', { name: 'Linear' }));
    expect(pressed(getByRole('button', { name: 'Linear' }))).toBe(true);
    // …volume is still linear (its own default)…
    fireEvent.click(getByRole('button', { name: 'Est. volume' }));
    expect(pressed(getByRole('button', { name: 'Linear' }))).toBe(true);
    // …and SFR kept the linear override instead of resetting to log.
    fireEvent.click(getByRole('button', { name: 'SFR' }));
    expect(pressed(getByRole('button', { name: 'Linear' }))).toBe(true);
    expect(pressed(getByRole('button', { name: 'Log' }))).toBe(false);
  });

  it('renders the volume view without crashing for gaps and extrapolated weeks', () => {
    const { container } = render(<TrendChart history={history} latestWeek="2026-05-30" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
