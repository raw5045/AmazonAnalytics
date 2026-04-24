import { and, asc, eq, inArray } from 'drizzle-orm';
import { inngest } from '../client';
import { db } from '@/db/client';
import { uploadBatches, uploadedFiles } from '@/db/schema';
import { startImportJob } from '@/worker/jobs';

export interface ImportBatchInput {
  batchId: string;
}

/**
 * Batch import coordinator (v3, step.waitForEvent pattern).
 *
 * History:
 *  v0  single step.run wrapping all files → 75-min step hit HTTP timeout
 *  v1  per-file step.invoke → each file's 15-min step hit HTTP timeout
 *  v2  detached-job pattern with poll loop (120 × 30s = 60 min / file) →
 *      worked for 5-file batch, but in the 10-file batch Neon got slower
 *      as kwm/search_terms grew. Files began taking 2+ hours, exceeding
 *      the poll budget. Orchestrator marked those "timed out" even though
 *      the background Promise eventually succeeded. Worse, after enough
 *      poll cycles the orchestrator hit an Inngest-level limit and died
 *      mid-batch, leaving 4 files stranded.
 *
 *  v3  (this)  detached-job pattern with step.waitForEvent. Orchestrator
 *      sleeps server-side (no step-budget cost) until worker/jobs.ts
 *      fires csv/file.import-completed for this specific file. Scales to
 *      arbitrary per-file durations up to the waitForEvent timeout (4h).
 *
 * Safety nets still in place:
 *   - concurrency:{limit:1} prevents two orchestrators in parallel
 *   - retries:0 prevents Inngest transport-retry re-entry
 *   - idempotency guard short-circuits if batch already importing/done
 *   - DB-level lock in processFileImport (import_started_at + 60min expiry)
 *   - race guard: check DB status BEFORE waitForEvent in case the job
 *     finished before we registered the listener
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

    // Per-file: kickoff + waitForEvent. No polling.
    const FILE_TIMEOUT = '4h'; // per-file upper bound; see history above

    for (const f of files) {
      // Kick off the detached background import.
      await step.run(`kickoff-${f.id}`, () => {
        const result = startImportJob(f.id);
        return { started: result.started, reason: result.reason ?? null };
      });

      // Race guard: the background Promise might have already finished if
      // the file was already imported (idempotency early-return) or very
      // fast, OR the kickoff returned {started:false, reason:'already-inflight'}
      // meaning a previous invocation's job is still running.
      const currentStatus = await step.run(`pre-wait-check-${f.id}`, async () => {
        const row = await db.query.uploadedFiles.findFirst({
          where: eq(uploadedFiles.id, f.id),
          columns: { validationStatus: true },
        });
        return row?.validationStatus ?? null;
      });

      let outcome: 'imported' | 'import_failed' | 'timeout';

      if (currentStatus === 'imported') {
        outcome = 'imported';
      } else if (currentStatus === 'import_failed') {
        outcome = 'import_failed';
      } else {
        // Wait server-side for the completion event. Matches the specific
        // file via `if` expression. Returns null on timeout.
        const completion = await step.waitForEvent(`await-${f.id}`, {
          event: 'csv/file.import-completed',
          if: `async.data.uploadedFileId == "${f.id}"`,
          timeout: FILE_TIMEOUT,
        });

        if (completion === null) {
          outcome = 'timeout';
        } else {
          const data = completion.data as { success?: boolean };
          outcome = data.success ? 'imported' : 'import_failed';
        }
      }

      if (outcome === 'imported') {
        imported++;
      } else {
        failed++;
        if (outcome === 'timeout') {
          await step.run(`mark-timeout-${f.id}`, () =>
            db
              .update(uploadedFiles)
              .set({
                validationStatus: 'import_failed',
                validationErrorsJson: {
                  error: `orchestrator waitForEvent timeout (>${FILE_TIMEOUT})`,
                },
                importStartedAt: null,
                importHeartbeatAt: null,
              })
              .where(eq(uploadedFiles.id, f.id)),
          );
        }
        // On import_failed outcome, worker/jobs.ts already updated the DB.
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

    await step.sendEvent('summary-refresh', {
      name: 'summary/refresh-requested',
      data: { batchId },
    });

    return { ok: true, imported, failed };
  },
);
