import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { VolumeChart } from './VolumeChart';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

import React from 'react';

vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  const ResponsiveContainer = ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
    React.cloneElement(children, { width: 600, height: 280 });
  return { ...actual, ResponsiveContainer };
});

function row(week: string, vol: number | null, extrap = false): KeywordDetailHistoryRow {
  return {
    weekEndDate: week, actualRank: 100, topClickedProduct1Asin: null, topClickedProduct1Title: null,
    topClickedProduct1ClickShare: null, topClickedProduct1ConversionShare: null,
    topClickedProduct2Asin: null, topClickedProduct2Title: null, topClickedProduct3Asin: null,
    topClickedProduct3Title: null, topClickedCategory1: null, keywordInTitle1: null, keywordInTitle2: null,
    keywordInTitle3: null, keywordTitleMatchCount: null, keywordInTitle1Loose: null, keywordInTitle2Loose: null,
    keywordInTitle3Loose: null, keywordTitleMatchCountLoose: null, fakeVolumeSeverity: null, fakeVolumeEvalStatus: null,
    estimatedMonthlyVolume: vol, estimatedMonthlyVolumeIsExtrapolated: extrap, variants: null,
  };
}

describe('VolumeChart', () => {
  it('renders without crashing for a mix of values, gaps, and extrapolated', () => {
    const history = [row('2026-05-16', 1200), row('2026-05-23', null), row('2026-05-30', 1500, true)];
    const { container } = render(<VolumeChart history={history} latestWeek="2026-05-30" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
