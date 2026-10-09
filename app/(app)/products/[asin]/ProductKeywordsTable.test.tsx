import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ProductKeywordRow } from '@/lib/products/loadProductKeywords';
import { ProductKeywordsTable } from './ProductKeywordsTable';

const ROWS: ProductKeywordRow[] = [
  {
    searchTermId: '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f',
    searchTermRaw: 'magnesium glycinate',
    currentRank: 1234,
    estimatedMonthlySearches: 45678,
    slot: 1,
    clickSharePct: 32.5,
    conversionSharePct: 18,
    weeksInTop3: 12,
    streakStartedWeek: '2026-07-18',
  },
  {
    searchTermId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    searchTermRaw: 'magnesium for sleep',
    currentRank: 98765,
    estimatedMonthlySearches: null,
    slot: 3,
    clickSharePct: null,
    conversionSharePct: null,
    weeksInTop3: 1,
    streakStartedWeek: '2026-10-03',
  },
];

/** The cells of the table row whose keyword link reads `keyword`. */
function cells(keyword: string): HTMLElement[] {
  const row = screen.getByRole('link', { name: keyword }).closest('tr');
  if (!row) throw new Error(`no row for ${keyword}`);
  return within(row).getAllByRole('cell');
}

describe('ProductKeywordsTable', () => {
  it('renders each keyword row in the loaded order: link, rank, est. searches, slot, shares, weeks in top 3', () => {
    render(<ProductKeywordsTable rows={ROWS} total={2} />);
    expect(screen.getByRole('link', { name: 'magnesium glycinate' })).toHaveAttribute(
      'href',
      '/explorer/keyword/3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f',
    );
    expect(cells('magnesium glycinate').map((c) => c.textContent)).toEqual([
      'magnesium glycinate',
      '1,234',
      '~45,678 / mo',
      '1',
      '32.5%',
      '18.0%',
      '12',
    ]);
    // An estimate the fit could not make and shares Amazon did not give are dashes (no "~").
    expect(cells('magnesium for sleep').map((c) => c.textContent)).toEqual([
      'magnesium for sleep',
      '98,765',
      '—',
      '3',
      '—',
      '—',
      '1',
    ]);
    const keywordLinks = screen.getAllByRole('link').map((a) => a.textContent);
    expect(keywordLinks).toEqual(['magnesium glycinate', 'magnesium for sleep']);
  });

  it('the weeks-in-top-3 cell carries the streak start week as its tooltip', () => {
    render(<ProductKeywordsTable rows={ROWS} total={2} />);
    expect(cells('magnesium glycinate')[6]).toHaveAttribute('title', expect.stringContaining('2026-07-18'));
    expect(cells('magnesium for sleep')[6]).toHaveAttribute('title', expect.stringContaining('2026-10-03'));
  });

  it('says "showing N of M" when the total is over the rows shown', () => {
    render(<ProductKeywordsTable rows={ROWS} total={1234} />);
    expect(screen.getByText(/Showing 2 of 1,234 keywords/)).toBeInTheDocument();
  });

  it('no "showing" line when every keyword is shown', () => {
    render(<ProductKeywordsTable rows={ROWS} total={2} />);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('empty: the one-line empty state and no table', () => {
    render(<ProductKeywordsTable rows={[]} total={0} />);
    expect(screen.getByText('Not a top-3 clicked product for any keyword this week')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
