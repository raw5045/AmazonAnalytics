import { and, asc, eq, inArray } from 'drizzle-orm';
import { inngest } from '../client';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { startImportJob } from '@/worker/jobs';

export interface ImportBatchInput {
  batchId: string;
}

/**
 * Batch import coordinator (version 2, detached-job pattern).
 *
 * Prior attempts failed because of Inngest's HTTP invocation timeout:
 *  v0 ran all files in one step.run → timed out at ~75 min
 *  v1 used step.invoke per file → each file's importFileFn step still ran
 *      15 min, exceeded Inngest's HTTP timeout, retried at transport layer,
 *      caused re-entry that wiped staging mid-import
 *
 * This version (v2) uses Inngest ONLY for coordination. Each Inngest step
 * finishes in < 1 second:
 *   - guard-idempotency: check batch state, mark importing
 *   - fetch-files: list files to import
 *   - kickoff-<file>: startImportJob(file_id) — spawns a detached Promise
 *     that runs processFileImport in the worker's Node process. Returns
 *     immediately, so the Inngest step completes quickly.
 *   - poll-wait-<file>-<N>: step.sleep 30s
 *   - poll-check-<file>-<N>: SELECT validation_status — one row lookup
 *   - When status is terminal, move to the next file.
 *
 * The heavy 15-minute processFileImport runs OUTSIDE any Inngest step, so
 * Inngest's HTTP timeout no longer applies.
 *
 * Protection against double-work:
 *   - concurrency:{limit:1} on this function blocks parallel orchestrators
 *   - retries:0 means no coordinator retries
 *   - idempotency guard early-returns if batch is already in-flight or done
 *   - processFileImport has its own DB-level re-entry lock via
 *     uploaded_files.import_started_at
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
    const guard = await step.run('guard-idempotency', async () => {
      const batch = await db.query.uploadBatches.findFirst({
        where: eq(uploadBatches.id, batchId),
      });
      if (!batch) return { skip: true as const, reason: 'not-found' };
      const terminal = ['imported', 'imported_partial', 'failed'];
      if (terminal.includes(batch.status)) {
        return { skip: true as const, reason: `already-${batch.status}` };
      }
      if (batch.status === 'importing') {
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

    // Step 2: fetch files ready to import.
    const files = await step.run('fetch-files', async () => {
      const rows = await db.query.uploadedFiles.findMany({
        where: and(
          eq(uploadedFiles.batchId, batchId),
          inArray(uploadedFiles.validationStatus, ['pass', 'pass_with_warnings']),
        ),
        orderBy: [asc(uploadedFiles.weekEndDate)],
        columns: { id: true, weekEndDate: true, originalFilename: true },
      });
      return rows.map((r) => ({ id: r.id, name: r.originalFilename }));
    });

    let imported = 0;
    let failed = 0;

    // Per-file loop: kick off a background job, then poll DB for terminal status.
    // Sequential, since importFileFn previously had concurrency:{limit:1} and
    // we want to preserve that serialization to avoid DB contention on a
    // single 2.8M-row COPY + INSERT pipeline.
    const POLL_INTERVAL = '30s';
    const MAX_POLLS = 120; // 120 * 30s = 60 min max per file

    for (const f of files) {
      // Kick off the detached job. This is a trivial step — it just hands
      // the work off to an in-process async Promise and returns.
      await step.run(`kickoff-${f.id}`, () => {
        const result = startImportJob(f.id);
        return { started: result.started, reason: result.reason ?? null };
      });

      // Poll the DB until the file reaches a terminal status.
      let done = false;
      for (let iter = 0; iter < MAX_POLLS && !done; iter++) {
        await step.sleep(`poll-wait-${f.id}-${iter}`, POLL_INTERVAL);
        const status = await step.run(`poll-check-${f.id}-${iter}`, async () => {
          const row = await db.query.uploadedFiles.findFirst({
            where: eq(uploadedFiles.id, f.id),
            columns: { validationStatus: true },
          });
          return row?.validationStatus ?? null;
        });
        if (status === 'imported') {
          imported++;
          done = true;
        } else if (status === 'import_failed') {
          failed++;
          done = true;
        }
      }

      if (!done) {
        // Orchestrator exceeded its poll budget. Mark the file failed so
        // the batch doesn't hang forever, and let user retry if needed.
        failed++;
        await step.run(`mark-timeout-${f.id}`, () =>
          db
            .update(uploadedFiles)
            .set({
              validationStatus: 'import_failed',
              validationErrorsJson: { error: 'orchestrator poll timeout (>60 min)' },
              importStartedAt: null,
            })
            .where(eq(uploadedFiles.id, f.id)),
        );
      }
    }

    // Finalize batch status.
    const finalStatus =
      failed === 0 ? 'imported' : imported === 0 ? 'failed' : 'imported_partial';
    await step.run('finalize-batch', () =>
      db
        .update(uploadBatches)
        .set({ status: finalStatus, completedAt: new Date() })
        .where(eq(uploadBatches.id, batchId)),
    );

    // Plan 3 hand-off.
    await step.sendEvent('summary-refresh', {
      name: 'summary/refresh-requested',
      data: { batchId },
    });

    return { ok: true, imported, failed };
  },
);
