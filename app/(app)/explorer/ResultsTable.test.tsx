import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ExplorerRow } from '@/lib/explorer/types';
import { ResultsTable } from './ResultsTable';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/explorer',
  useSearchParams: () => new URLSearchParams(),
}));

/** One fully-populated row so the table renders its header (the empty state has no header). */
function makeRow(): ExplorerRow {
  return {
    searchTermId: 'st-1',
    searchTermRaw: 'led desk lamp',
    currentRank: 1200,
    priorRank: 1500,
    improvement: 300,
    topClickedCategory1: 'Home & Kitchen',
    fakeVolumeSeverity: null,
    keywordTitleMatchCount: 2,
    keywordInTitle1: true,
    keywordInTitle2: true,
    keywordInTitle3: false,
    keywordTitleMatchCountLoose: 3,
    keywordInTitle1Loose: true,
    keywordInTitle2Loose: true,
    keywordInTitle3Loose: true,
    topClickedProduct1Asin: 'B000000001',
    topClickedProduct1Title: 'LED Desk Lamp',
    topClickedProduct1ClickShare: '12.5',
    topClickedProduct1ConversionShare: '9.1',
    estimatedMonthlyVolumeCurrent: 42_000,
    volumePrior: 38_000,
    volumeDelta: 4_000,
    avgPriceCents: 2599,
    avgReviews: 1834,
    topClickedLeafCategory: 'Desk Lamps',
  };
}

describe('ResultsTable avg-column tooltips (null-key exclusion under the avg sorts)', () => {
  it('explorer: the Avg price / Avg reviews headers say sorting hides keywords without a value', () => {
    render(<ResultsTable rows={[makeRow()]} window="4w" matchMode="loose" currentSort="avg_reviews_desc" backUrl="/explorer" />);
    expect(screen.getByTitle(/hides keywords with no average price/i)).toBeInTheDocument();
    expect(screen.getByTitle(/hides keywords with no average review count/i)).toBeInTheDocument();
  });

  it('watchlist (sortHidesIneligible=false): they sort last instead, and nothing says "hidden"', () => {
    render(
      <ResultsTable rows={[makeRow()]} window="4w" matchMode="loose" currentSort="rank" backUrl="/watchlist" sortHidesIneligible={false} />,
    );
    expect(screen.getByTitle(/no average price sort last/i)).toBeInTheDocument();
    expect(screen.getByTitle(/no average review count sort last/i)).toBeInTheDocument();
    expect(screen.queryByTitle(/hidden under this sort|hides keywords/i)).not.toBeInTheDocument();
  });
});
