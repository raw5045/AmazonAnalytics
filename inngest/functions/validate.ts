import { eq } from 'drizzle-orm';
import { inngest } from '../client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { validateCsvStream } from '@/lib/csv/validation/orchestrate';
import { db } from '@/db/client';
import { uploadedFiles, reportingWeeks, ingestionErrors } from '@/db/schema';

export interface ValidateFileInput {
  uploadedFileId: string;
}

export interface ValidateFileOutput {
  outcome: 'pass' | 'pass_with_warnings' | 'fail';
}

function parseReportingDateToIso(d: string | undefined): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export async function processFileValidation(
  input: ValidateFileInput,
): Promise<ValidateFileOutput> {
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, input.uploadedFileId),
  });
  if (!file) throw new Error(`uploaded file ${input.uploadedFileId} not found`);

  const stream = await downloadStreamFromR2(file.storageKey);
  const result = await validateCsvStream({
    stream,
    rollingAvgRowCount: undefined,
    rollingAvgBlankShareRate: undefined,
  });

  // Check for duplicate-week
  const weekEndDateIso = parseReportingDateToIso(result.reportingDate);
  if (weekEndDateIso && !file.isReplacement) {
    const existing = await db.query.reportingWeeks.findFirst({
      where: eq(reportingWeeks.weekEndDate, weekEndDateIso),
    });
    if (existing) {
      result.errors.push({
        severity: 'error',
        code: 'WEEK_ALREADY_LOADED',
        message: `Week ${weekEndDateIso} already exists. Use replace flow to overwrite.`,
      });
    }
  }

  const finalOutcome: ValidateFileOutput['outcome'] =
    result.errors.length > 0
      ? 'fail'
      : result.warnings.length > 0
        ? 'pass_with_warnings'
        : 'pass';

  // Persist per-row errors
  if (result.errors.length > 0) {
    const rows = result.errors.slice(0, 500).map((e) => ({
      uploadedFileId: input.uploadedFileId,
      severity: e.severity,
      code: e.code,
      message: e.message,
      rowNumber: e.rowNumber ?? null,
      columnName: e.columnName ?? null,
    }));
    if (rows.length > 0) {
      await db.insert(ingestionErrors).values(rows);
    }
  }

  // Persist summary on uploaded_files
  await db
    .update(uploadedFiles)
    .set({
      validationStatus: finalOutcome,
      validationErrorsJson: { errors: result.errors.slice(0, 500), total: result.errors.length },
      validationWarningsJson: { warnings: result.warnings },
      validationInfoJson: { stats: result.stats },
      rowCountRaw: result.stats.rowCount,
      weekEndDate: weekEndDateIso ?? undefined,
      reportingDateRaw: result.reportingDate ?? null,
    })
    .where(eq(uploadedFiles.id, input.uploadedFileId));

  return { outcome: finalOutcome };
}

export const validateFileFn = inngest.createFunction(
  {
    id: 'validate-file',
    name: 'Validate uploaded file',
    triggers: [{ event: 'csv/file.validate' }],
  },
  async ({ event, step }) => {
    const data = event.data as { uploadedFileId: string };
    return step.run('validate', () =>
      processFileValidation({
        uploadedFileId: data.uploadedFileId,
      }),
    );
  },
);
