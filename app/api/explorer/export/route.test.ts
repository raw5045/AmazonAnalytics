import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRequireUser, mockCountToday, mockBump, mockExpand, mockRun } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockCountToday: vi.fn(),
  mockBump: vi.fn().mockResolvedValue(undefined),
  mockExpand: vi.fn(),
  mockRun: vi.fn(),
}));

vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/activity/readToday', () => ({ countUserActivityToday: mockCountToday }));
vi.mock('@/lib/activity/bump', () => ({ bumpUserActivity: mockBump }));
vi.mock('@/lib/customCategories/expand', () => ({ expandCustomCategories: mockExpand }));
vi.mock('@/lib/explorer/runQuery', () => ({ runExplorerQuery: mockRun }));

import { GET } from './route';
import { AuthError } from '@/lib/auth/AuthError';

const user = { id: 'uuid-1', email: 'jane@shop.co', name: 'Jane', role: 'standard_user' };

const explorerRow = {
  searchTermId: '11111111-2222-3333-4444-555555555555',
  searchTermRaw: 'magnesium glycinate',
  currentRank: 1234,
  priorRank: 2000,
  improvement: 766,
  topClickedCategory1: 'Health & Household',
  fakeVolumeSeverity: 'none',
  keywordTitleMatchCount: 2,
  keywordInTitle1: true,
  keywordInTitle2: true,
  keywordInTitle3: false,
  keywordTitleMatchCountLoose: 3,
  keywordInTitle1Loose: true,
  keywordInTitle2Loose: true,
  keywordInTitle3Loose: true,
  topClickedProduct1Asin: 'B000000001',
  topClickedProduct1Title: 'Magnesium',
  topClickedProduct1ClickShare: '12.34',
  topClickedProduct1ConversionShare: '2.5',
  estimatedMonthlyVolumeCurrent: 48210,
  volumePrior: 30000,
  volumeDelta: 18210,
  avgPriceCents: 1999,
  avgReviews: 4321,
  topClickedLeafCategory: 'Health & Household › Magnesium',
};

function queryResult(over: Record<string, unknown> = {}) {
  return {
    rows: [explorerRow, { ...explorerRow, searchTermRaw: 'zinc' }],
    hasNext: false,
    total: 2,
    totalIsCapped: false,
    volumeFit: null,
    currentWeekEndDate: '2026-09-12',
    timings: { metaLookupMs: 1, rowsMs: 1, countMs: 0, usedPredicate: true, countSource: 'deferred' },
    ...over,
  };
}

const req = (qs: string) => new Request(`http://localhost/api/explorer/export?${qs}`);

describe('GET /api/explorer/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(user);
    mockCountToday.mockResolvedValue(0);
    mockExpand.mockResolvedValue(['Health & Household › Magnesium']);
    mockRun.mockResolvedValue(queryResult());
  });

  it('returns 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    const res = await GET(req('rank_max=100'));
    expect(res.status).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns 429 once the daily cap is reached, without running the query or counting', async () => {
    mockCountToday.mockResolvedValueOnce(10);
    const res = await GET(req('rank_max=100'));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/10 per day/);
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockBump).not.toHaveBeenCalled();
  });

  it('streams a CSV download of the filtered rows and counts the export', async () => {
    const res = await GET(req('rank_max=100&sort=imp&window=4w'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="keywordquarry-keywords-2026-09-12.csv"',
    );
    expect(res.headers.get('x-export-rows')).toBe('2');
    expect(res.headers.get('x-export-truncated')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    // text() strips a leading BOM by spec; check the wire bytes (what the browser saves).
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain('Prior rank (4w)');
    expect(body).toContain('magnesium glycinate,1234,2000,766,');
    expect(body).toContain('zinc,');
    // The runner gets the page's filters with the export cap as the page size.
    const filters = mockRun.mock.calls[0][0];
    expect(filters).toMatchObject({ rankMax: 100, sort: 'imp', window: '4w', page: 1, perPage: 10_000 });
    expect(mockBump).toHaveBeenCalledWith('uuid-1', 'explorer_export');
  });

  it('expands the user’s custom categories into the leaf filter before querying', async () => {
    mockExpand.mockResolvedValueOnce(['A › B', 'C › D']);
    await GET(req('custom=11111111-1111-1111-1111-111111111111&leaf=E%20%E2%80%BA%20F'));
    expect(mockExpand).toHaveBeenCalledWith('uuid-1', ['11111111-1111-1111-1111-111111111111'], ['E › F']);
    expect(mockRun.mock.calls[0][0].leafPaths).toEqual(['A › B', 'C › D']);
  });

  it('does not touch custom categories when none are selected', async () => {
    await GET(req('rank_max=100'));
    expect(mockExpand).not.toHaveBeenCalled();
  });

  it('flags a truncated export when more rows exist beyond the cap', async () => {
    mockRun.mockResolvedValueOnce(queryResult({ hasNext: true }));
    const res = await GET(req('rank_max=100'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-truncated')).toBe('true');
  });

  it('returns 504 without counting when the broad search timed out', async () => {
    mockRun.mockResolvedValueOnce(queryResult({ rows: [], broadTimedOut: true }));
    const res = await GET(req('q=vitamin&qmode=broad'));
    expect(res.status).toBe(504);
    expect(mockBump).not.toHaveBeenCalled();
  });
});
