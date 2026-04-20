import type { ValidationIssue } from './types';

const SHARE_COLUMNS = [
  'Top Clicked Product #1: Click Share',
  'Top Clicked Product #1: Conversion Share',
  'Top Clicked Product #2: Click Share',
  'Top Clicked Product #2: Conversion Share',
  'Top Clicked Product #3: Click Share',
  'Top Clicked Product #3: Conversion Share',
] as const;

function isBlank(v: string | undefined): boolean {
  return v === undefined || v === null || v.trim() === '';
}

export function checkRowHardFail(
  row: Record<string, string>,
  rowNumber: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Missing search term
  if (isBlank(row['Search Term'])) {
    issues.push({
      severity: 'error',
      code: 'MISSING_SEARCH_TERM',
      message: `Row ${rowNumber}: Search Term is blank`,
      rowNumber,
      columnName: 'Search Term',
    });
  }

  // Rank validity
  const rankStr = row['Search Frequency Rank'];
  const rank = Number(rankStr);
  if (isBlank(rankStr) || Number.isNaN(rank) || !Number.isFinite(rank) || rank <= 0 || !Number.isInteger(rank)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_RANK',
      message: `Row ${rowNumber}: Search Frequency Rank '${rankStr}' is not a positive integer`,
      rowNumber,
      columnName: 'Search Frequency Rank',
    });
  }

  // Share validity
  for (const col of SHARE_COLUMNS) {
    const val = row[col];
    if (isBlank(val)) continue;
    const n = Number(val);
    if (Number.isNaN(n)) {
      issues.push({
        severity: 'error',
        code: 'NON_NUMERIC_SHARE',
        message: `Row ${rowNumber}: ${col} '${val}' is not numeric`,
        rowNumber,
        columnName: col,
      });
    } else if (n < 0 || n > 100) {
      issues.push({
        severity: 'error',
        code: 'SHARE_OUT_OF_RANGE',
        message: `Row ${rowNumber}: ${col} ${n} is outside allowed 0–100 range`,
        rowNumber,
        columnName: col,
      });
    }
  }

  return issues;
}

export interface FileLevelHardFailInput {
  rowCount?: number;
  reportingDatesSeen?: Set<string>;
  duplicateSearchTerms?: string[];
}

export function checkFileLevelHardFail(input: FileLevelHardFailInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (input.rowCount !== undefined && input.rowCount === 0) {
    issues.push({
      severity: 'error',
      code: 'ZERO_DATA_ROWS',
      message: 'File has zero valid data rows',
    });
  }

  if (input.reportingDatesSeen && input.reportingDatesSeen.size > 1) {
    issues.push({
      severity: 'error',
      code: 'MIXED_REPORTING_DATE',
      message: `File has multiple reporting dates: ${Array.from(input.reportingDatesSeen).join(', ')}`,
    });
  }

  if (input.duplicateSearchTerms && input.duplicateSearchTerms.length > 0) {
    const first = input.duplicateSearchTerms.slice(0, 5).join(', ');
    const more = input.duplicateSearchTerms.length > 5 ? ` (and ${input.duplicateSearchTerms.length - 5} more)` : '';
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_SEARCH_TERM',
      message: `Duplicate search terms in file: ${first}${more}`,
    });
  }

  return issues;
}
