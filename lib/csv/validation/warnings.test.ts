import { describe, it, expect } from 'vitest';
import { checkRowCountAnomaly, checkBlankShareShift } from './warnings';

describe('checkRowCountAnomaly', () => {
  it('no warning when within 50–200% of rolling avg', () => {
    const issues = checkRowCountAnomaly({ rowCount: 1_000_000, rollingAvg: 1_000_000 });
    expect(issues).toEqual([]);
  });

  it('warns when row count < 50% of rolling avg', () => {
    const issues = checkRowCountAnomaly({ rowCount: 400_000, rollingAvg: 1_000_000 });
    expect(issues[0].code).toBe('ROW_COUNT_LOW');
  });

  it('warns when row count > 200% of rolling avg', () => {
    const issues = checkRowCountAnomaly({ rowCount: 2_500_000, rollingAvg: 1_000_000 });
    expect(issues[0].code).toBe('ROW_COUNT_HIGH');
  });

  it('no warning when rolling avg is undefined (first upload)', () => {
    expect(checkRowCountAnomaly({ rowCount: 1_000_000, rollingAvg: undefined })).toEqual([]);
  });
});

describe('checkBlankShareShift', () => {
  it('warns when blank share rate jumps by more than 20 percentage points', () => {
    const issues = checkBlankShareShift({ currentRate: 0.45, rollingAvgRate: 0.2 });
    expect(issues[0].code).toBe('BLANK_SHARE_SHIFT');
  });

  it('no warning when change is within 20pp', () => {
    expect(checkBlankShareShift({ currentRate: 0.3, rollingAvgRate: 0.2 })).toEqual([]);
  });

  it('no warning when rolling avg is undefined', () => {
    expect(checkBlankShareShift({ currentRate: 0.5, rollingAvgRate: undefined })).toEqual([]);
  });
});
