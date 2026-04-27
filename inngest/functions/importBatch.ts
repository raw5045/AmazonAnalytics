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

    // Per-file: kickoff + poll loop of short waitForEvents that also check
    // DB heartbeat staleness. Replaces the old single 4h waitForEvent which
    // would happily wait full duration even if the worker had crashed and
    // could never fire the completion event. Now the orchestrator detects
    // an orphaned job within ~5–10 min instead of 4 hours.
    const POLL_INTERVAL = '5m';
    const MAX_POLLS = 24; // 24 × 5m = 2h total per file (well above observed import times)
    const HEARTBEAT_STALE_MS = 3 * 60_000; // matches processFileImport's lock condition

    for (const f of files) {
      await step.run(`kickoff-${f.id}`, () => {
        const result = startImportJob(f.id);
        return { started: result.started, reason: result.reason ?? null };
      });

      let outcome: 'imported' | 'import_failed' | 'orphaned' | 'timeout' = 'timeout';
      let pollIter = 0;

      while (pollIter < MAX_POLLS) {
        // Check current DB state before waiting. Catches the race where
        // the job finished (or was already done) before we registered.
        const status = await step.run(`status-${f.id}-${pollIter}`, async () => {
          const row = await db.query.uploadedFiles.findFirst({
            where: eq(uploadedFiles.id, f.id),
            columns: { validationStatus: true, importHeartbeatAt: true },
          });
          return {
            validationStatus: row?.validationStatus ?? null,
            heartbeatAt: row?.importHeartbeatAt ?? null,
          };
        });

        if (status.validationStatus === 'imported') {
          outcome = 'imported';
          break;
        }
        if (status.validationStatus === 'import_failed') {
          outcome = 'import_failed';
          break;
        }

        // Detect orphaned job: heartbeat is older than the staleness
        // threshold, meaning the worker that started the import has died.
        // No completion event will ever fire from a dead Promise; mark
        // failed and move on. This is the new detection path that prevents
        // the 4-hour wait when a worker crashed mid-COPY.
        const hbAt = status.heartbeatAt ? new Date(status.heartbeatAt).getTime() : null;
        // Skip the staleness check on iteration 0 — kickoff just happened
        // and the worker may not have written its first heartbeat yet.
        if (pollIter > 0 && hbAt !== null && Date.now() - hbAt > HEARTBEAT_STALE_MS) {
          outcome = 'orphaned';
          break;
        }

        // Wait for the completion event with a short timeout. If it fires
        // we exit immediately on the next iteration's status check (the
        // worker writes status before firing the event). If it doesn't,
        // we re-check heartbeat staleness and decide whether to keep waiting.
        await step.waitForEvent(`await-${f.id}-${pollIter}`, {
          event: 'csv/file.import-completed',
          if: `async.data.uploadedFileId == "${f.id}"`,
          timeout: POLL_INTERVAL,
        });

        pollIter++;
      }

      if (outcome === 'imported') {
        imported++;
      } else {
        failed++;
        // Mark file failed for outcomes that don't already update the DB.
        // (worker/jobs.ts marks 'import_failed' itself when processFileImport
        // throws; orphaned + timeout are orchestrator-side only.)
        if (outcome === 'orphaned' || outcome === 'timeout') {
          const reason =
            outcome === 'orphaned'
              ? 'worker died: heartbeat stale > 3 min while orchestrator was waiting'
              : `orchestrator poll budget exhausted (>${MAX_POLLS} × ${POLL_INTERVAL})`;
          await step.run(`mark-${outcome}-${f.id}`, () =>
            db
              .update(uploadedFiles)
              .set({
                validationStatus: 'import_failed',
                validationErrorsJson: { error: reason, outcome },
                importStartedAt: null,
                importHeartbeatAt: null,
              })
              .where(eq(uploadedFiles.id, f.id)),
          );
        }
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
