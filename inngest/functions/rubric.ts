import { createHash } from 'crypto';
import { inngest } from '../client';
import { downloadFromR2 } from '@/lib/storage/r2';
import { parseRubric, REQUIRED_COLUMNS } from '@/lib/csv/parseRubric';
import { db } from '@/db/client';
import { schemaVersions, uploadedFiles } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export interface RubricStepInput {
  uploadedFileId: string;
  storageKey: string;
}

export interface RubricStepOutput {
  schemaVersionId: string;
}

/**
 * Pure pipeline logic, testable without Inngest runtime.
 */
export async function processRubricUpload(input: RubricStepInput): Promise<RubricStepOutput> {
  const buf = await downloadFromR2(input.storageKey);
  const parsed = await parseRubric(buf, { sampleSize: 100 });

  // Determine next version number
  const rawResult = await db.execute(
    sql`SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion" FROM schema_versions`,
  );
  const rows = (Array.isArray(rawResult)
    ? rawResult
    : (rawResult as unknown as { rows: Array<{ nextVersion: number }> }).rows) as Array<{
    nextVersion: number;
  }>;
  const nextVersion = Number(rows[0].nextVersion);

  const headerHash = createHash('sha256').update(parsed.headers.join('|')).digest('hex');

  const [version] = await db
    .insert(schemaVersions)
    .values({
      versionNumber: nextVersion,
      status: 'draft',
      headerRowIndex: parsed.headerRowIndex,
      requiredColumnsJson: { columns: REQUIRED_COLUMNS, detected: parsed.headers },
      headerHash,
      sampleFileId: input.uploadedFileId,
      notes: `Week: ${parsed.weekStartDate} - ${parsed.weekEndDate}`,
    })
    .returning();

  // Link uploaded file to schema version
  await db
    .update(uploadedFiles)
    .set({
      schemaVersionId: version.id,
      weekEndDate: parsed.weekEndDate,
      weekStartDate: parsed.weekStartDate,
      reportingDateRaw: parsed.reportingDateRaw,
      metadataRowRaw: parsed.metadataRowRaw,
    })
    .where(eq(uploadedFiles.id, input.uploadedFileId));

  return { schemaVersionId: version.id };
}

export const rubricUploadedFn = inngest.createFunction(
  {
    id: 'rubric-uploaded',
    name: 'Process rubric upload',
    triggers: [{ event: 'csv/rubric.uploaded' }],
  },
  async ({ event, step }) => {
    const data = event.data as { uploadedFileId: string; storageKey: string };
    const result = await step.run('process-rubric', () =>
      processRubricUpload({
        uploadedFileId: data.uploadedFileId,
        storageKey: data.storageKey,
      }),
    );
    return result;
  },
);
