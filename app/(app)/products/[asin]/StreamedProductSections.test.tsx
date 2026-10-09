import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HistoryPoint } from '@/lib/products/loadProductHistory';
import type { ProductKeywordRow } from '@/lib/products/loadProductKeywords';

const loaders = vi.hoisted(() => ({ history: vi.fn(), keywords: vi.fn() }));
vi.mock('@/lib/products/loadProductHistory', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/loadProductHistory')>()),
  loadProductHistory: loaders.history,
}));
vi.mock('@/lib/products/loadProductKeywords', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/loadProductKeywords')>()),
  loadProductKeywords: loaders.keywords,
}));
// The lazy recharts wrapper is out of scope here: record what the section hands it.
const charts = vi.hoisted(() => ({ calls: [] as Array<{ points: unknown[]; capped?: boolean }> }));
vi.mock('./LazyHistoryCharts', () => ({
  LazyHistoryCharts: (props: { points: unknown[]; capped?: boolean }) => {
    charts.calls.push(props);
    return null;
  },
  HistorySkeleton: () => null,
}));

import { PRODUCT_HISTORY_CAP } from '@/lib/products/loadProductHistory';
import { HistorySection, KeywordsSection } from './StreamedProductSections';

const ASIN = 'B0CXYZ1234';
const run = async () => [];
/** A DB error whose message carries a bound value: it must never reach the log. */
const SECRET = 'B0SECRET01';
const dbError = () => Object.assign(new Error(`invalid input syntax for type integer: "${SECRET}"`), { code: '22P02' });

function point(fetchedAt: string): HistoryPoint {
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
  };
}

const ROW: ProductKeywordRow = {
  searchTermId: '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f',
  searchTermRaw: 'magnesium glycinate',
  currentRank: 1234,
  estimatedMonthlySearches: 45678,
  slot: 1,
  clickSharePct: 32.5,
  conversionSharePct: 18,
  weeksInTop3: 12,
  streakStartedWeek: '2026-07-18',
};

let logged: MockInstance<typeof console.error>;
beforeEach(() => {
  vi.clearAllMocks();
  charts.calls = [];
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe('HistorySection', () => {
  it('a never-fetched row: "No history yet" without calling the history loader', async () => {
    render(await HistorySection({ run, asin: ASIN, fetched: false }));
    expect(screen.getByText('No history yet')).toBeInTheDocument();
    expect(loaders.history).not.toHaveBeenCalled();
    expect(charts.calls).toHaveLength(0);
  });

  it('hands the charts only the five charted fields, not capped under the loader cap', async () => {
    loaders.history.mockResolvedValue([point('2026-09-27T06:00:00.000Z'), point('2026-10-04T06:00:00.000Z')]);
    render(await HistorySection({ run, asin: ASIN, fetched: true }));
    expect(loaders.history).toHaveBeenCalledWith(run, ASIN);
    expect(charts.calls).toHaveLength(1);
    expect(charts.calls[0].capped).toBe(false);
    expect(charts.calls[0].points).toEqual([
      { fetchedAt: '2026-09-27T06:00:00.000Z', currentPriceCents: 1999, salesRank: 1234, reviewCount: 1800, monthlySold: 1000 },
      { fetchedAt: '2026-10-04T06:00:00.000Z', currentPriceCents: 1999, salesRank: 1234, reviewCount: 1800, monthlySold: 1000 },
    ]);
  });

  it('a full page from the loader (the cap) is flagged capped', async () => {
    loaders.history.mockResolvedValue(Array.from({ length: PRODUCT_HISTORY_CAP }, () => point('2026-10-04T06:00:00.000Z')));
    render(await HistorySection({ run, asin: ASIN, fetched: true }));
    expect(charts.calls[0].capped).toBe(true);
    expect(charts.calls[0].points).toHaveLength(PRODUCT_HISTORY_CAP);
  });

  it('no snapshots: "No history yet" without the chart chunk', async () => {
    loaders.history.mockResolvedValue([]);
    render(await HistorySection({ run, asin: ASIN, fetched: true }));
    expect(screen.getByText('No history yet')).toBeInTheDocument();
    expect(charts.calls).toHaveLength(0);
  });

  it('a loader failure fails soft and logs only { error, code }, never the message', async () => {
    loaders.history.mockRejectedValue(dbError());
    render(await HistorySection({ run, asin: ASIN, fetched: true }));
    expect(screen.getByText(/Couldn.t load the history — refresh to retry/)).toBeInTheDocument();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('[product history] load failed', JSON.stringify({ error: 'Error', code: '22P02' }));
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('invalid input');
  });
});

describe('KeywordsSection', () => {
  it('renders the keywords table from the loader', async () => {
    loaders.keywords.mockResolvedValue({ rows: [ROW], total: 1 });
    render(await KeywordsSection({ run, asin: ASIN }));
    expect(loaders.keywords).toHaveBeenCalledWith(run, ASIN);
    expect(screen.getByRole('link', { name: 'magnesium glycinate' })).toHaveAttribute('href', `/explorer/keyword/${ROW.searchTermId}`);
  });

  it('a loader failure fails soft and logs only { error, code }, never the message', async () => {
    loaders.keywords.mockRejectedValue(dbError());
    render(await KeywordsSection({ run, asin: ASIN }));
    expect(screen.getByText(/Couldn.t load the keywords — refresh to retry/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('[product keywords] load failed', JSON.stringify({ error: 'Error', code: '22P02' }));
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
  });

  it('a thrown non-Error (a bare string) logs only its type', async () => {
    loaders.keywords.mockRejectedValue(`connection to ${SECRET} refused`);
    render(await KeywordsSection({ run, asin: ASIN }));
    expect(logged).toHaveBeenCalledWith('[product keywords] load failed', JSON.stringify({ error: 'string' }));
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
  });
});
