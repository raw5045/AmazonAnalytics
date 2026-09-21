import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

import { addDays, computeHistoryWindow, loadKeywordHistory } from './history';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import type { FitParams } from '@/lib/analytics/volumeModel';
import { fakePool as pool } from './testing/fakePool';

const row = (weekEndDate: string, actualRank: number, vol: number | null = 1000): KeywordDetailHistoryRow => ({
  weekEndDate, actualRank, estimatedMonthlyVolume: vol, estimatedMonthlyVolumeIsExtrapolated: false, fakeVolumeSeverity: null, fakeVolumeEvalStatus: null,
  topClickedProduct1Asin: null, topClickedProduct1Title: null, topClickedProduct1ClickShare: null, topClickedProduct1ConversionShare: null,
  topClickedProduct2Asin: null, topClickedProduct2Title: null, topClickedProduct3Asin: null, topClickedProduct3Title: null, topClickedCategory1: null,
  keywordInTitle1: null, keywordInTitle2: null, keywordInTitle3: null, keywordTitleMatchCount: null,
  keywordInTitle1Loose: null, keywordInTitle2Loose: null, keywordInTitle3Loose: null, keywordTitleMatchCountLoose: null, variants: null,
});

/** Build a single-segment FitParams (mirrors the fixture helper in lib/explorer/chartSeries.test.ts). */
function singleFit(calibrationMonthEndDate: string, fittedAt: string, beta: number, scaleFactor: number): FitParams {
  return { calibrationMonthEndDate, fittedAt, beta, scaleFactor, breakpoints: [], segments: [{ beta, scaleFactor }] };
}

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
  it('weeks=1 windows to exactly the dataset week — no earlier week is reachable', () => {
    const rows = [row('2026-09-12', 100), row('2026-09-05', 200)];
    const w = computeHistoryWindow(rows, '2026-09-12', 1);
    expect(w.windowStart).toBe('2026-09-12');
    expect(w.windowEnd).toBe('2026-09-12');
    expect(w.points.map((p) => p.weekEndDate)).toEqual(['2026-09-12']);
    expect(w.missingWeeks).toEqual([]);
  });
  it('weeks=52 windows exactly 357 days back (51 full weeks before the dataset week); a row one week further back falls outside', () => {
    const rows = [row('2026-09-12', 100), row('2025-09-20', 900), row('2025-09-13', 5000)];
    const w = computeHistoryWindow(rows, '2026-09-12', 52);
    expect(w.windowStart).toBe('2025-09-20');
    expect(w.windowEnd).toBe('2026-09-12');
    expect(w.points.map((p) => p.weekEndDate)).toEqual(['2025-09-20', '2026-09-12']);
    expect(w.missingWeeks).toHaveLength(50); // 52 weekly slots, only the two boundary weeks present
  });
});

describe('loadKeywordHistory', () => {
  const META = { week: '2026-09-12', snap: 's', refreshed: '2026-09-13T06:00:00.000Z', fit_id: null, cal_month: null, extrapolated: false };
  const fits = async () => [];
  const TERM_SQL = 'SELECT search_term_raw FROM search_terms WHERE id = $1';

  it('reads the keyword and its cached series in one transaction and windows it', async () => {
    const series = [{ w: '2026-09-05', r: 110, sev: null, es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }, { w: '2026-09-12', r: 100, sev: 'warning', es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }];
    const p = pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'hair oil' }], keyword_chart_series: [{ series, updated_at: '2026-09-13T07:00:00.000Z' }] }).pool;
    const out = await loadKeywordHistory('id-1', 3, { pool: p, timeoutMs: 10_000, fetchFits: fits });
    expect(out).toMatchObject({ searchTermId: 'id-1', keyword: 'hair oil', windowStart: '2026-08-29', windowEnd: '2026-09-12', requestedWeeks: 3, source: 'chart_series', seriesUpdatedAt: '2026-09-13T07:00:00.000Z' });
    expect(out.points.map((p) => [p.weekEndDate, p.rank, p.severity])).toEqual([['2026-09-05', 110, null], ['2026-09-12', 100, 'warning']]);
    expect(out.missingWeeks).toEqual(['2026-08-29']);
    expect(out.points.every((p) => p.estimatedMonthlySearches === null)).toBe(true);
    expect(out.warnings.map((w) => w.code)).toEqual(['ESTIMATED_VOLUME', 'MISSING_WEEKS']);
  });

  it('is KEYWORD_NOT_FOUND for an unknown id and HISTORY_UNAVAILABLE without a series row', async () => {
    await expect(loadKeywordHistory('nope', 13, { pool: pool({ keyword_current_summary_meta: [META] }).pool, timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'KEYWORD_NOT_FOUND' });
    await expect(loadKeywordHistory('id-1', 13, { pool: pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'x' }] }).pool, timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
  });

  it('is HISTORY_UNAVAILABLE when the series row exists but its series array is empty, same as no row at all', async () => {
    const p = pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'hair oil' }], keyword_chart_series: [{ series: [], updated_at: '2026-09-13T07:00:00.000Z' }] }).pool;
    await expect(loadKeywordHistory('id-1', 13, { pool: p, timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
  });

  it('is DATA_UNAVAILABLE when the snapshot meta row is absent (the kill switch)', async () => {
    await expect(loadKeywordHistory('id-1', 13, { pool: pool({}).pool, timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', retryable: true });
  });

  it('a 57014 mid-transaction is QUERY_TIMEOUT, with the budget in the message', async () => {
    const p = pool({ keyword_current_summary_meta: [META] }, { sql: TERM_SQL, code: '57014' }).pool;
    await expect(loadKeywordHistory('id-1', 13, { pool: p, timeoutMs: 10_000, fetchFits: fits })).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true, message: expect.stringContaining('10-second') });
  });

  it('orders warnings ESTIMATED_VOLUME, then SERIES_BEHIND_DATASET, then MISSING_WEEKS when both conditions hold', async () => {
    // Series only reaches 2026-09-05 — one week short of the dataset week 2026-09-12 (SERIES_BEHIND_DATASET),
    // and the window (weeks=3) also has a gap at 2026-08-29 (MISSING_WEEKS).
    const series = [{ w: '2026-09-05', r: 110, sev: null, es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }];
    const p = pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'hair oil' }], keyword_chart_series: [{ series, updated_at: '2026-09-13T07:00:00.000Z' }] }).pool;
    const out = await loadKeywordHistory('id-1', 3, { pool: p, timeoutMs: 10_000, fetchFits: fits });
    expect(out.warnings.map((w) => w.code)).toEqual(['ESTIMATED_VOLUME', 'SERIES_BEHIND_DATASET', 'MISSING_WEEKS']);
  });

  it('flows a non-empty fits list through deps.fetchFits into estimatedMonthlySearches on each point', async () => {
    const series = [{ w: '2026-09-05', r: 110, sev: null, es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }, { w: '2026-09-12', r: 100, sev: null, es: null, cs: null, vs: null, t: [null, null, null], tl: [null, null, null] }];
    const p = pool({ keyword_current_summary_meta: [META], 'FROM search_terms': [{ search_term_raw: 'hair oil' }], keyword_chart_series: [{ series, updated_at: '2026-09-13T07:00:00.000Z' }] }).pool;
    const fitsWithData = async () => [singleFit('2026-08-31', '2026-09-01T00:00:00Z', 0.7, 2_000_000)];
    const out = await loadKeywordHistory('id-1', 2, { pool: p, timeoutMs: 10_000, fetchFits: fitsWithData });
    expect(out.points).toHaveLength(2);
    for (const point of out.points) {
      expect(typeof point.estimatedMonthlySearches).toBe('number');
      expect(point.volumeIsExtrapolated).toBe(false);
    }
  });

  it('rejects an out-of-range weeks before ever touching the database (programming-error guard; keywordHistoryInputSchema is the caller-facing gate at the API boundary)', async () => {
    const poisonPool = { connect: async () => { throw new Error('must not connect to the database'); } } as never;
    await expect(loadKeywordHistory('id-1', 0, { pool: poisonPool, timeoutMs: 10_000, fetchFits: fits })).rejects.toThrow('loadKeywordHistory: weeks must be an integer 1..52, got 0');
    await expect(loadKeywordHistory('id-1', 53, { pool: poisonPool, timeoutMs: 10_000, fetchFits: fits })).rejects.toThrow('loadKeywordHistory: weeks must be an integer 1..52, got 53');
    await expect(loadKeywordHistory('id-1', 13.5, { pool: poisonPool, timeoutMs: 10_000, fetchFits: fits })).rejects.toThrow('loadKeywordHistory: weeks must be an integer 1..52, got 13.5');
  });
});
