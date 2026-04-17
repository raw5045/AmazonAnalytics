import { parse } from 'csv-parse/sync';

export const REQUIRED_COLUMNS = [
  'Search Frequency Rank',
  'Search Term',
  'Top Clicked Brand #1',
  'Top Clicked Brands #2',
  'Top Clicked Brands #3',
  'Top Clicked Category #1',
  'Top Clicked Category #2',
  'Top Clicked Category #3',
  'Top Clicked Product #1: ASIN',
  'Top Clicked Product #1: Product Title',
  'Top Clicked Product #1: Click Share',
  'Top Clicked Product #1: Conversion Share',
  'Top Clicked Product #2: ASIN',
  'Top Clicked Product #2: Product Title',
  'Top Clicked Product #2: Click Share',
  'Top Clicked Product #2: Conversion Share',
  'Top Clicked Product #3: ASIN',
  'Top Clicked Product #3: Product Title',
  'Top Clicked Product #3: Click Share',
  'Top Clicked Product #3: Conversion Share',
  'Reporting Date',
] as const;

export class RubricParseError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RubricParseError';
  }
}

export interface RubricParseResult {
  metadataRowRaw: string;
  headers: string[];
  headerRowIndex: number;
  weekStartDate: string | null;
  weekEndDate: string | null;
  reportingDateRaw: string | null;
  sampleRows: Record<string, string>[];
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseReportingDate(value: string): string {
  // M/D/YYYY → YYYY-MM-DD
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new RubricParseError('INVALID_DATE', `Unrecognized date format: ${value}`);
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function extractWeekRange(metadata: string): {
  weekStartDate: string | null;
  weekEndDate: string | null;
} {
  // Matches "Select week=["Week 15 | 2026-04-05 - 2026-04-11 2026"]" regardless
  // of how quotes survive CSV parsing and re-serialization.
  const m = metadata.match(
    /Select week=\[.*?Week \d+ \| (\d{4}-\d{2}-\d{2}) - (\d{4}-\d{2}-\d{2})/,
  );
  if (!m) return { weekStartDate: null, weekEndDate: null };
  return { weekStartDate: m[1], weekEndDate: m[2] };
}

export async function parseRubric(
  buf: Buffer,
  opts: { sampleSize?: number } = {},
): Promise<RubricParseResult> {
  const sampleSize = opts.sampleSize ?? 100;
  const text = stripBom(buf.toString('utf-8'));

  const allRows: string[][] = parse(text, {
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  if (allRows.length < 2) {
    throw new RubricParseError('EMPTY_FILE', 'File has fewer than 2 rows');
  }

  const metadataRow = allRows[0];
  const headerRow = allRows[1];
  const metadataRowRaw = metadataRow.map((c) => JSON.stringify(c)).join(',');

  // Validate headers
  for (const required of REQUIRED_COLUMNS) {
    if (!headerRow.includes(required)) {
      throw new RubricParseError(
        'MISSING_HEADER',
        `Required header not found: ${required}`,
      );
    }
  }

  const { weekStartDate, weekEndDate } = extractWeekRange(metadataRowRaw);

  const dataRowsRaw = allRows.slice(2, 2 + sampleSize);
  const sampleRows: Record<string, string>[] = dataRowsRaw.map((row) => {
    const obj: Record<string, string> = {};
    headerRow.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });

  // Validate reporting dates
  const reportingDateIdx = headerRow.indexOf('Reporting Date');
  const reportingDates = new Set(dataRowsRaw.map((r) => r[reportingDateIdx]).filter(Boolean));
  if (reportingDates.size > 1) {
    throw new RubricParseError(
      'MIXED_REPORTING_DATE',
      `mixed reporting date values found: ${Array.from(reportingDates).join(', ')}`,
    );
  }

  const reportingDateRaw = reportingDates.values().next().value ?? null;
  const reportingDateIso = reportingDateRaw ? parseReportingDate(reportingDateRaw) : null;

  // Cross-validate: reporting date should match weekEndDate if both present
  if (reportingDateIso && weekEndDate && reportingDateIso !== weekEndDate) {
    throw new RubricParseError(
      'DATE_MISMATCH',
      `Reporting date ${reportingDateRaw} does not match week end date ${weekEndDate}`,
    );
  }

  return {
    metadataRowRaw,
    headers: headerRow,
    headerRowIndex: 1,
    weekStartDate,
    weekEndDate: weekEndDate ?? reportingDateIso,
    reportingDateRaw,
    sampleRows,
  };
}
