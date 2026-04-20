import type { ValidationIssue } from './types';

export interface RowCountAnomalyInput {
  rowCount: number;
  rollingAvg: number | undefined;
}

export function checkRowCountAnomaly(input: RowCountAnomalyInput): ValidationIssue[] {
  if (input.rollingAvg === undefined || input.rollingAvg === 0) return [];
  const ratio = input.rowCount / input.rollingAvg;
  if (ratio < 0.5) {
    return [
      {
        severity: 'warning',
        code: 'ROW_COUNT_LOW',
        message: `Row count ${input.rowCount} is below 50% of recent average (${input.rollingAvg})`,
      },
    ];
  }
  if (ratio > 2.0) {
    return [
      {
        severity: 'warning',
        code: 'ROW_COUNT_HIGH',
        message: `Row count ${input.rowCount} is above 200% of recent average (${input.rollingAvg})`,
      },
    ];
  }
  return [];
}

export interface BlankShareShiftInput {
  currentRate: number;
  rollingAvgRate: number | undefined;
}

export function checkBlankShareShift(input: BlankShareShiftInput): ValidationIssue[] {
  if (input.rollingAvgRate === undefined) return [];
  const delta = Math.abs(input.currentRate - input.rollingAvgRate);
  if (delta >= 0.2) {
    return [
      {
        severity: 'warning',
        code: 'BLANK_SHARE_SHIFT',
        message: `Blank share rate ${(input.currentRate * 100).toFixed(1)}% shifted ≥20pp from recent average ${(input.rollingAvgRate * 100).toFixed(1)}%`,
      },
    ];
  }
  return [];
}
