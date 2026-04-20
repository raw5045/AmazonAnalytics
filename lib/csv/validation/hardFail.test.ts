import { describe, it, expect } from 'vitest';
import { checkRowHardFail, checkFileLevelHardFail } from './hardFail';

describe('checkRowHardFail', () => {
  const validRow = {
    'Search Frequency Rank': '5',
    'Search Term': 'magnesium',
    'Top Clicked Product #1: Click Share': '12.5',
    'Top Clicked Product #1: Conversion Share': '3.4',
    'Top Clicked Product #2: Click Share': '',
    'Top Clicked Product #2: Conversion Share': '',
    'Top Clicked Product #3: Click Share': '',
    'Top Clicked Product #3: Conversion Share': '',
    'Reporting Date': '4/11/2026',
  };

  it('returns no issues for a valid row', () => {
    expect(checkRowHardFail(validRow, 5)).toEqual([]);
  });

  it('flags invalid rank (non-numeric)', () => {
    const issues = checkRowHardFail({ ...validRow, 'Search Frequency Rank': 'abc' }, 5);
    expect(issues[0].code).toBe('INVALID_RANK');
  });

  it('flags invalid rank (zero or negative)', () => {
    const issues = checkRowHardFail({ ...validRow, 'Search Frequency Rank': '0' }, 5);
    expect(issues[0].code).toBe('INVALID_RANK');
  });

  it('flags non-numeric share when present', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': 'abc' },
      5,
    );
    expect(issues[0].code).toBe('NON_NUMERIC_SHARE');
  });

  it('flags out-of-range share (> 100)', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': '150' },
      5,
    );
    expect(issues[0].code).toBe('SHARE_OUT_OF_RANGE');
  });

  it('flags out-of-range share (< 0)', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': '-5' },
      5,
    );
    expect(issues[0].code).toBe('SHARE_OUT_OF_RANGE');
  });

  it('allows blank shares', () => {
    const issues = checkRowHardFail(
      { ...validRow, 'Top Clicked Product #1: Click Share': '' },
      5,
    );
    expect(issues).toEqual([]);
  });

  it('flags missing search term', () => {
    const issues = checkRowHardFail({ ...validRow, 'Search Term': '' }, 5);
    expect(issues[0].code).toBe('MISSING_SEARCH_TERM');
  });
});

describe('checkFileLevelHardFail', () => {
  it('flags mixed reporting dates', () => {
    const issues = checkFileLevelHardFail({ reportingDatesSeen: new Set(['4/11/2026', '4/18/2026']) });
    expect(issues.some((i) => i.code === 'MIXED_REPORTING_DATE')).toBe(true);
  });

  it('flags zero data rows', () => {
    const issues = checkFileLevelHardFail({ rowCount: 0 });
    expect(issues.some((i) => i.code === 'ZERO_DATA_ROWS')).toBe(true);
  });

  it('flags duplicate search term', () => {
    const issues = checkFileLevelHardFail({ duplicateSearchTerms: ['magnesium', 'tinnitus'] });
    expect(issues.some((i) => i.code === 'DUPLICATE_SEARCH_TERM')).toBe(true);
  });

  it('passes when everything is clean', () => {
    expect(
      checkFileLevelHardFail({
        rowCount: 100,
        reportingDatesSeen: new Set(['4/11/2026']),
        duplicateSearchTerms: [],
      }),
    ).toEqual([]);
  });
});
