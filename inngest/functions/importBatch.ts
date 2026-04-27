import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
    // 10 minutes — matches processFileImport's lock-acquire staleness check.
    // Was 3 min initially but observed: heartbeat can stall up to ~5 min
    // during the long kwm_insert phase even when the worker is healthy.
    // 10 min eliminates the false-positive without giving up worker-death
    // recovery (a real dead worker isn't coming back).
    const HEARTBEAT_STALE_MS = 10 * 60_000;

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
      } else if (outcome === 'orphaned' || outcome === 'timeout') {
        // CAS-style flip: only mark failed if the file is STILL in 'pass'
        // status. If the worker won the race (its kwm_insert finished
        // and processFileImport flipped the file to 'imported' between
        // our last status check and this update), respect that — the
        // data is in kwm and the worker's outcome is the source of truth.
        const reason =
          outcome === 'orphaned'
            ? `worker heartbeat stale > ${HEARTBEAT_STALE_MS / 60_000} min while orchestrator was waiting`
            : `orchestrator poll budget exhausted (>${MAX_POLLS} × ${POLL_INTERVAL})`;
        const updated = await step.run(`mark-${outcome}-${f.id}`, async () => {
          const result = await db.execute<{ id: string }>(sql`
            UPDATE uploaded_files
            SET validation_status = 'import_failed',
                validation_errors_json = ${JSON.stringify({ error: reason, outcome })}::jsonb,
                import_started_at = NULL,
                import_heartbeat_at = NULL
            WHERE id = ${f.id}
              AND validation_status IN ('pass', 'pass_with_warnings')
            RETURNING id
          `);
          return result.rows.length > 0;
        });
        if (updated) {
          failed++;
        } else {
          // Worker won the race; the file is already 'imported' (or
          // 'import_failed' from worker's catch path). Count it
          // accordingly by re-reading status.
          const finalStatus = await step.run(`recheck-${f.id}`, async () => {
            const row = await db.query.uploadedFiles.findFirst({
              where: eq(uploadedFiles.id, f.id),
              columns: { validationStatus: true },
            });
            return row?.validationStatus ?? null;
          });
          if (finalStatus === 'imported') imported++;
          else failed++;
        }
      } else {
        // outcome === 'import_failed' — worker marked it failed itself
        // via worker/jobs.ts catch path. Already updated; just count.
        failed++;
      }
    }

    // Finalize batch status — re-read from DB to get the source-of-truth
    // counts. The orchestrator's in-memory `imported` / `failed` counters
    // can lag the worker: when a slow file's heartbeat went stale, the
    // orchestrator counted it 'failed' even though the worker eventually
    // won and flipped status to 'imported'. The CAS-style mark-orphaned
    // protects file-level status from being stomped, but the batch
    // counter needs this re-read to match reality.
    const finalSummary = await step.run('finalize-summary', async () => {
      const rows = (await db.execute<{ validation_status: string; c: number }>(sql`
        SELECT validation_status, COUNT(*)::int AS c
        FROM uploaded_files
        WHERE batch_id = ${batchId}
        GROUP BY validation_status
      `)).rows;
      const counts = Object.fromEntries(rows.map((r) => [r.validation_status, r.c]));
      const importedDb = counts.imported ?? 0;
      const failedDb = (counts.import_failed ?? 0) + (counts.fail ?? 0);
      return { imported: importedDb, failed: failedDb };
    });

    const finalStatus =
      finalSummary.failed === 0
        ? 'imported'
        : finalSummary.imported === 0
          ? 'failed'
          : 'imported_partial';
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

    return {
      ok: true,
      imported: finalSummary.imported,
      failed: finalSummary.failed,
      // For visibility, log the orchestrator's in-flight tally too — diff
      // between this and the DB-derived counts indicates how many files
      // were "saved" by a slow worker winning the race.
      orchestratorTally: { imported, failed },
    };
  },
);
