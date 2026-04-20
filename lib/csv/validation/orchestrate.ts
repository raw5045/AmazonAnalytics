import type { Readable } from 'node:stream';
import { streamParseCsv } from '../streamParse';
import { checkRowHardFail, checkFileLevelHardFail } from './hardFail';
import { checkRowCountAnomaly, checkBlankShareShift } from './warnings';
import { createStatsAccumulator } from './informational';
import type { ValidationIssue, ValidationStats } from './types';

export interface ValidateInput {
  stream: Readable;
  rollingAvgRowCount: number | undefined;
  rollingAvgBlankShareRate: number | undefined;
}

export interface ValidateResult {
  outcome: 'pass' | 'pass_with_warnings' | 'fail';
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: ValidationStats;
  reportingDate: string | undefined;
}

export async function validateCsvStream(input: ValidateInput): Promise<ValidateResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const statsAcc = createStatsAccumulator();
  const seenDates = new Set<string>();
  const seenTerms = new Set<string>();
  const duplicateTerms: string[] = [];
  let rowNumber = 0;

  for await (const row of streamParseCsv(input.stream)) {
    rowNumber++;
    const rowErrors = checkRowHardFail(row, rowNumber);
    errors.push(...rowErrors);

    const d = row['Reporting Date'];
    if (d) seenDates.add(d);

    const term = row['Search Term'];
    if (term) {
      if (seenTerms.has(term)) duplicateTerms.push(term);
      else seenTerms.add(term);
    }

    statsAcc.consume(row);
  }

  const stats = statsAcc.finalize();

  errors.push(
    ...checkFileLevelHardFail({
      rowCount: stats.rowCount,
      reportingDatesSeen: seenDates,
      duplicateSearchTerms: duplicateTerms,
    }),
  );

  warnings.push(
    ...checkRowCountAnomaly({
      rowCount: stats.rowCount,
      rollingAvg: input.rollingAvgRowCount,
    }),
  );

  const currentBlankRate = stats.rowCount > 0 ? stats.rowsWithAnyBlankShare / stats.rowCount : 0;
  warnings.push(
    ...checkBlankShareShift({
      currentRate: currentBlankRate,
      rollingAvgRate: input.rollingAvgBlankShareRate,
    }),
  );

  const outcome: ValidateResult['outcome'] =
    errors.length > 0 ? 'fail' : warnings.length > 0 ? 'pass_with_warnings' : 'pass';

  const reportingDate = seenDates.size === 1 ? seenDates.values().next().value : undefined;

  return { outcome, errors, warnings, stats, reportingDate };
}
