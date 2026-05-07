import { describe, it, expect } from 'vitest';
import {
  buildWeekCalendar,
  gapFillHistory,
  groupTopProductRuns,
} from './formatHistory';
import type { KeywordDetailHistoryRow } from './fetchKeywordDetail';

const blankRow = (overrides: Partial<KeywordDetailHistoryRow>): KeywordDetailHistoryRow => ({
  weekEndDate: '2026-05-02',
  actualRank: 1000,
  topClickedProduct1Asin: null,
  topClickedProduct1Title: null,
  topClickedProduct1ClickShare: null,
  topClickedProduct1ConversionShare: null,
  topClickedProduct2Asin: null,
  topClickedProduct2Title: null,
  topClickedProduct3Asin: null,
  topClickedProduct3Title: null,
  topClickedCategory1: null,
  keywordInTitle1: null,
  keywordInTitle2: null,
  keywordInTitle3: null,
  keywordTitleMatchCount: null,
  fakeVolumeSeverity: null,
  fakeVolumeEvalStatus: null,
  ...overrides,
});

describe('buildWeekCalendar', () => {
  it('produces N consecutive weekly dates ending at latestWeek', () => {
    const cal = buildWeekCalendar('2026-05-02', 4);
    expect(cal).toEqual(['2026-04-11', '2026-04-18', '2026-04-25', '2026-05-02']);
  });

  it('handles 52-week request', () => {
    const cal = buildWeekCalendar('2026-05-02', 52);
    expect(cal).toHaveLength(52);
    expect(cal[0]).toBe('2025-05-10');
    expect(cal[51]).toBe('2026-05-02');
  });
});

describe('gapFillHistory', () => {
  it('returns one row per calendar week, with raw row when present', () => {
    const calendar = ['2026-04-11', '2026-04-18', '2026-04-25', '2026-05-02'];
    const history = [
      blankRow({ weekEndDate: '2026-04-18', actualRank: 200 }),
      blankRow({ weekEndDate: '2026-05-02', actualRank: 100 }),
    ];
    const filled = gapFillHistory(history, calendar);
    expect(filled).toHaveLength(4);
    expect(filled[0].actualRank).toBeNull();
    expect(filled[1].actualRank).toBe(200);
    expect(filled[2].actualRank).toBeNull();
    expect(filled[3].actualRank).toBe(100);
  });

  it('preserves the full raw row for present weeks', () => {
    const calendar = ['2026-05-02'];
    const history = [
      blankRow({ weekEndDate: '2026-05-02', actualRank: 42, topClickedProduct1Asin: 'B0123' }),
    ];
    const filled = gapFillHistory(history, calendar);
    expect(filled[0].raw?.topClickedProduct1Asin).toBe('B0123');
  });
});

describe('groupTopProductRuns', () => {
  it('groups consecutive same-ASIN weeks', () => {
    const history = [
      blankRow({ weekEndDate: '2026-04-11', topClickedProduct1Asin: 'A', topClickedProduct1Title: 'Title A' }),
      blankRow({ weekEndDate: '2026-04-18', topClickedProduct1Asin: 'A', topClickedProduct1Title: 'Title A' }),
      blankRow({ weekEndDate: '2026-04-25', topClickedProduct1Asin: 'B', topClickedProduct1Title: 'Title B' }),
      blankRow({ weekEndDate: '2026-05-02', topClickedProduct1Asin: 'A', topClickedProduct1Title: 'Title A' }),
    ];
    const runs = groupTopProductRuns(history);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ asin: 'A', startWeek: '2026-04-11', endWeek: '2026-04-18', weeks: 2 });
    expect(runs[1]).toMatchObject({ asin: 'B', startWeek: '2026-04-25', endWeek: '2026-04-25', weeks: 1 });
    expect(runs[2]).toMatchObject({ asin: 'A', startWeek: '2026-05-02', endWeek: '2026-05-02', weeks: 1 });
  });

  it('breaks runs across null-ASIN weeks', () => {
    const history = [
      blankRow({ weekEndDate: '2026-04-11', topClickedProduct1Asin: 'A' }),
      blankRow({ weekEndDate: '2026-04-18', topClickedProduct1Asin: null }),
      blankRow({ weekEndDate: '2026-04-25', topClickedProduct1Asin: 'A' }),
    ];
    const runs = groupTopProductRuns(history);
    expect(runs).toHaveLength(2);
    expect(runs[0].endWeek).toBe('2026-04-11');
    expect(runs[1].startWeek).toBe('2026-04-25');
  });

  it('averages click and conversion shares across the run', () => {
    const history = [
      blankRow({
        weekEndDate: '2026-04-11',
        topClickedProduct1Asin: 'A',
        topClickedProduct1ClickShare: '50.0',
        topClickedProduct1ConversionShare: '2.0',
      }),
      blankRow({
        weekEndDate: '2026-04-18',
        topClickedProduct1Asin: 'A',
        topClickedProduct1ClickShare: '60.0',
        topClickedProduct1ConversionShare: '4.0',
      }),
    ];
    const runs = groupTopProductRuns(history);
    expect(runs[0].avgClickShare).toBe(55);
    expect(runs[0].avgConversionShare).toBe(3);
  });

  it('handles empty history gracefully', () => {
    expect(groupTopProductRuns([])).toEqual([]);
  });

  it('skips runs that begin with a null ASIN', () => {
    const history = [
      blankRow({ weekEndDate: '2026-04-11', topClickedProduct1Asin: null }),
      blankRow({ weekEndDate: '2026-04-18', topClickedProduct1Asin: 'A' }),
    ];
    const runs = groupTopProductRuns(history);
    expect(runs).toHaveLength(1);
    expect(runs[0].asin).toBe('A');
  });
});
