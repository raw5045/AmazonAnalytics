import { and, asc, eq, inArray } from 'drizzle-orm';
import { inngest } from '../client';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { importFileFn } from './importFile';

export interface ImportBatchInput {
  batchId: string;
}

/**
 * Batch import coordinator.
 *
 * Design notes (rewritten to fix the concurrency bug that produced duplicate
 * staging rows and silent zero-row imports in batch 8b20651d):
 *
 * - `retries: 0` — this function is pure orchestration. If it fails mid-way,
 *   the user re-clicks Import; the idempotency guard below handles that.
 *   The old code used the Inngest default (3 retries), which combined with
 *   a 60+ minute monolithic step caused retried invocations to run
 *   concurrently with the original still in-flight in the worker.
 *
 * - `concurrency: { limit: 1 }` is kept as belt-and-suspenders, but the real
 *   serialization protection is on `importFileFn` (which processes one file
 *   at a time and also has `retries: 0`).
 *
 * - Each file is imported via `step.invoke(importFileFn, ...)` — each file
 *   is its own Inngest run, with its own step/timeout budget. Previously
 *   the code called `processFileImport` as a plain function inside a single
 *   `step.run`, which made the whole batch a single 60+ minute step.
 *
 * - The idempotency guard in the first step short-circuits if the batch is
 *   already in a terminal or in-flight state. This makes the event safe to
 *   re-send (e.g. user double-clicks Import, or Inngest dedup fires).
 */
export const importBatchFn = inngest.createFunction(
  {
    id: 'import-batch',
    name: 'Import all valid files in a batch',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ event: 'csv/batch.import-approved' }],
  },
  async ({ event, step }) => {
    const batchId = (event.data as { batchId: string }).batchId;

    // Step 1: idempotency guard + mark importing.
    // Wrapped in step.run so it's checkpointed — rerunning the function won't
    // re-flip status, and if something crashes after this we have an audit
    // trail of when 'importing' was set.
    const guard = await step.run('guard-idempotency', async () => {
      const batch = await db.query.uploadBatches.findFirst({
        where: eq(uploadBatches.id, batchId),
      });
      if (!batch) {
        return { skip: true as const, reason: 'not-found' };
      }
      const terminal = ['imported', 'imported_partial', 'failed'];
      if (terminal.includes(batch.status)) {
        return { skip: true as const, reason: `already-${batch.status}` };
      }
      if (batch.status === 'importing') {
        // Another run already claimed this batch. Don't start a parallel one.
        return { skip: true as const, reason: 'already-importing' };
      }
      await db
        .update(uploadBatches)
        .set({ status: 'importing' })
        .where(eq(uploadBatches.id, batchId));
      return { skip: false as const };
    });

    if (guard.skip) {
      return { ok: true, skipped: true, reason: guard.reason };
    }

    // Step 2: fetch files that are ready to import.
    const files = await step.run('fetch-files', async () => {
      const rows = await db.query.uploadedFiles.findMany({
        where: and(
          eq(uploadedFiles.batchId, batchId),
          inArray(uploadedFiles.validationStatus, ['pass', 'pass_with_warnings']),
        ),
        orderBy: [asc(uploadedFiles.weekEndDate)],
        columns: { id: true, weekEndDate: true, originalFilename: true },
      });
      // Drizzle returns Date for timestamp columns; strip to ID list for the loop
      return rows.map((r) => ({ id: r.id, weekEndDate: r.weekEndDate, name: r.originalFilename }));
    });

    let imported = 0;
    let failed = 0;

    // Step 3: invoke each file's import as its own Inngest function run.
    // importFileFn has concurrency:{limit:1} so files serialize automatically.
    // Each run gets its own step budget — no more 75-minute mega-steps.
    for (const f of files) {
      try {
        await step.invoke(`import-${f.id}`, {
          function: importFileFn,
          data: { uploadedFileId: f.id },
          // 45 min is ~3x the observed ~15 min for a 2.8M-row file. If a
          // single file really exceeds this, something is wrong and we want
          // to fail fast rather than silently orphan.
          timeout: '45m',
        });
        imported++;
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        await step.run(`mark-failed-${f.id}`, () =>
          db
            .update(uploadedFiles)
            .set({
              validationStatus: 'import_failed',
              validationErrorsJson: { error: msg },
            })
            .where(eq(uploadedFiles.id, f.id)),
        );
      }
    }

    // Step 4: finalize batch status.
    const finalStatus =
      failed === 0 ? 'imported' : imported === 0 ? 'failed' : 'imported_partial';
    await step.run('finalize-batch', () =>
      db
        .update(uploadBatches)
        .set({ status: finalStatus, completedAt: new Date() })
        .where(eq(uploadBatches.id, batchId)),
    );

    // Step 5: hand off to Plan 3 summary refresh (no-op handler for now).
    await step.sendEvent('summary-refresh', {
      name: 'summary/refresh-requested',
      data: { batchId },
    });

    return { ok: true, imported, failed };
  },
);
