import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

import { addDays, computeHistoryWindow, loadKeywordHistory } from './history';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

const row = (weekEndDate: string, actualRank: number, vol: number | null = 1000): KeywordDetailHistoryRow => ({
  weekEndDate, actualRank, estimatedMonthlyVolume: vol, estimatedMonthlyVolumeIsExtrapolated: false, fakeVolumeSeverity: null, fakeVolumeEvalStatus: null,
  topClickedProduct1Asin: null, topClickedProduct1Title: null, topClickedProduct1ClickShare: null, topClickedProduct1ConversionShare: null,
  topClickedProduct2Asin: null, topClickedProduct2Title: null, topClickedProduct3Asin: null, topClickedProduct3Title: null, topClickedCategory1: null,
  keywordInTitle1: null, keywordInTitle2: null, keywordInTitle3: null, keywordTitleMatchCount: null,
  keywordInTitle1Loose: null, keywordInTitle2Loose: null, keywordInTitle3Loose: null, keywordTitleMatchCountLoose: null, variants: null,
});

describe('computeHistoryWindow (Q29)', () => {
  it('keeps only the calendar window ending at the dataset week, oldest first, and lists missing weeks instead of inventing zeros', () => {
    const rows = [row('2026-09-12', 100), row('2026-08-29', 120), row('2024-01-06', 5000), row('2026-09-05', 110)];
    const w = computeHistoryWindow(rows, '2026-09-12', 4);
    expect(w.windowStart).toBe('2026-08-22');
    expect(w.windowEnd).toBe('2026-09-12');
    expect(w.points.map((p) => p.weekEndDate)).toEqual(['2026-08-29', '2026-09-05', '2026-09-12']);
    expect(w.missingWeeks).toEqual(['2026-08-22']);
    expect(w.points[0]).toEqual({ weekEndDate: '2026-08-29', rank: 120, estimatedMonthlySearches: 1000, volumeIsExtrapolated: false, severity: null });
  });
  it('addDays is UTC calendar math', () => {
    expect(addDays('2026-03-08', -7)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('loadKeywordHistory', () => {
  const META = { week: '2026-09-12', snap: 's', refreshed: '2026-09-13T06:00:00.000Z', fit_id: null, cal_month: null, extrapolated: false };
  function pool(answers: Record<string, unknown[]>) {
    const client = {
      query: vi.fn(async (sql: string) => ({ rows: Object.entries(answers).find(([k]) => sql.includes(k))?.[1] ?? [] })),
      release: vi.fn(),
      // withReadOnlyTx (lib/db/tcpPool.ts) attaches a no-op 'error' listener to the checked-out
      // client for the duration of the transaction and removes it in `finally` — the fake
      // client needs both so that plumbing doesn't throw (same convention as search.test.ts).
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    return { connect: async () => client } as never;
  }
  const fits = async () => [];
  it('reads the keyword and its cached series in one transaction and windows it', async () => {
    const series = [{ w: '2026-09-05', r: 110, sev: null, es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }, { w: '2026-09-12', r: 100, sev: 'warning', es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }];
    const p = pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'hair oil' }], keyword_chart_series: [{ series, updated_at: '2026-09-13T07:00:00.000Z' }] });
    const out = await loadKeywordHistory('id-1', 3, { pool: p, timeoutMs: 10_000, fetchFits: fits });
    expect(out).toMatchObject({ searchTermId: 'id-1', keyword: 'hair oil', windowStart: '2026-08-29', windowEnd: '2026-09-12', requestedWeeks: 3, source: 'chart_series', seriesUpdatedAt: '2026-09-13T07:00:00.000Z' });
    expect(out.points.map((p) => [p.weekEndDate, p.rank, p.severity])).toEqual([['2026-09-05', 110, null], ['2026-09-12', 100, 'warning']]);
    expect(out.missingWeeks).toEqual(['2026-08-29']);
    expect(out.points.every((p) => p.estimatedMonthlySearches === null)).toBe(true);
    expect(out.warnings.map((w) => w.code)).toEqual(['ESTIMATED_VOLUME', 'MISSING_WEEKS']);
  });
  it('is KEYWORD_NOT_FOUND for an unknown id and HISTORY_UNAVAILABLE without a series row', async () => {
    await expect(loadKeywordHistory('nope', 13, { pool: pool({ keyword_current_summary_meta: [META] }), timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'KEYWORD_NOT_FOUND' });
    await expect(loadKeywordHistory('id-1', 13, { pool: pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'x' }] }), timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
  });
});
