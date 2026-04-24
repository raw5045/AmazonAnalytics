/**
 * Detached background job runner for long imports.
 *
 * Why this exists: Inngest's HTTP invocation has a server-side timeout
 * (~2-5 minutes for non-streaming, observable as "Service Unavailable" 503
 * when exceeded). A 2.8M-row CSV import takes 10-15+ minutes — and under
 * load it can take 2+ hours as DB indexes grow. Running that work
 * synchronously inside an Inngest step hits the HTTP timeout; transport-level
 * retries then re-enter processFileImport and wipe the previous run's
 * staging rows mid-import.
 *
 * Fix: run processFileImport as a detached Promise in the worker's Node
 * process. The Inngest orchestrator (importBatchFn) only uses Inngest for
 * coordination — short step.run calls to kick off a job, then a
 * step.waitForEvent to sleep server-side until this runner fires the
 * csv/file.import-completed event. The actual import work happens outside
 * Inngest's step lifecycle entirely, so HTTP timeouts don't apply.
 *
 * Durability: if the worker crashes mid-job, the detached Promise dies.
 * uploaded_files.import_started_at serves as a DB-level lock with a
 * 60-minute expiry. After that, a manual retry can reclaim the file.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';
import { processFileImport } from '@/inngest/functions/importFile';
import { inngest } from '@/inngest/client';

// In-process dedup: avoids two sibling Promises racing to acquire the same
// DB lock if the kickoff step runs twice in rapid succession.
const inflight = new Set<string>();

export function startImportJob(uploadedFileId: string): { started: boolean; reason?: string } {
  if (inflight.has(uploadedFileId)) {
    return { started: false, reason: 'already-inflight' };
  }
  inflight.add(uploadedFileId);

  // Detach — don't await. The Promise runs in background; the caller
  // gets an immediate response. Errors are caught and marked
  // `import_failed` in DB. On success OR failure we fire an Inngest
  // event so the orchestrator's step.waitForEvent wakes up.
  (async () => {
    let success = false;
    let error: string | null = null;
    try {
      await processFileImport({ uploadedFileId });
      success = true;
      console.log(`[job] import-file ${uploadedFileId.slice(0, 8)} ok`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`[job] import-file ${uploadedFileId.slice(0, 8)} failed:`, error);
      try {
        await db
          .update(uploadedFiles)
          .set({
            validationStatus: 'import_failed',
            validationErrorsJson: { error },
            importStartedAt: null,
          })
          .where(eq(uploadedFiles.id, uploadedFileId));
      } catch (updateErr) {
        console.error(
          `[job] failed to mark ${uploadedFileId.slice(0, 8)} as import_failed:`,
          updateErr,
        );
      }
    } finally {
      inflight.delete(uploadedFileId);
      // Fire completion event. Orchestrator's step.waitForEvent
      // correlates by data.uploadedFileId.
      try {
        await inngest.send({
          name: 'csv/file.import-completed',
          data: { uploadedFileId, success, error },
        });
      } catch (sendErr) {
        console.error(
          `[job] failed to fire completion event for ${uploadedFileId.slice(0, 8)}:`,
          sendErr,
        );
      }
    }
  })();

  return { started: true };
}
