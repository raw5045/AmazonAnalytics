import { and, asc, eq, inArray } from 'drizzle-orm';
import { inngest } from '../client';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { processFileImport } from './importFile';
import { withNeonRetry } from '@/lib/db/retry';

export interface ImportBatchInput {
  batchId: string;
}

export async function processBatchImport(input: ImportBatchInput): Promise<void> {
  // Mark batch importing (retry: neon-http fetch connection may be stale after idle)
  await withNeonRetry(() =>
    db.update(uploadBatches).set({ status: 'importing' }).where(eq(uploadBatches.id, input.batchId)),
  );

  // Fetch passing files ordered by week
  const files = await withNeonRetry(() =>
    db.query.uploadedFiles.findMany({
      where: and(
        eq(uploadedFiles.batchId, input.batchId),
        inArray(uploadedFiles.validationStatus, ['pass', 'pass_with_warnings']),
      ),
      orderBy: [asc(uploadedFiles.weekEndDate)],
    }),
  );

  let imported = 0;
  let failed = 0;

  for (const f of files) {
    try {
      await processFileImport({ uploadedFileId: f.id });
      imported++;
    } catch (e) {
      failed++;
      await withNeonRetry(() =>
        db
          .update(uploadedFiles)
          .set({
            validationStatus: 'import_failed',
            validationErrorsJson: { error: e instanceof Error ? e.message : String(e) },
          })
          .where(eq(uploadedFiles.id, f.id)),
      );
    }
  }

  const finalStatus = failed === 0 ? 'imported' : imported === 0 ? 'failed' : 'imported_partial';
  await withNeonRetry(() =>
    db
      .update(uploadBatches)
      .set({ status: finalStatus, completedAt: new Date() })
      .where(eq(uploadBatches.id, input.batchId)),
  );

  // Fire Plan 3 handoff
  await inngest.send({ name: 'summary/refresh-requested', data: { batchId: input.batchId } });
}

export const importBatchFn = inngest.createFunction(
  { id: 'import-batch', name: 'Import all valid files in a batch', concurrency: { limit: 1 }, triggers: [{ event: 'csv/batch.import-approved' }] },
  async ({ event, step }) => {
    await step.run('import-batch', () =>
      processBatchImport({ batchId: (event.data as { batchId: string }).batchId }),
    );
    return { ok: true };
  },
);
