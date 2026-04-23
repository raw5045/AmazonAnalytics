/**
 * Detached background job runner for long imports.
 *
 * Why this exists: Inngest's HTTP invocation has a server-side timeout
 * (~2-5 minutes for non-streaming, observable as "Service Unavailable" 503
 * when exceeded). A 2.8M-row CSV import takes 10-15 minutes — if we run
 * that work synchronously inside an Inngest step, the HTTP call times out
 * and Inngest retries at the transport layer (bypassing function-level
 * `retries: 0`). Each transport retry re-enters processFileImport, whose
 * idempotency DELETE at the top wipes the previous invocation's staging
 * rows mid-import. Net effect: silent data corruption.
 *
 * Fix: run processFileImport as a detached Promise in the worker's Node
 * process. The Inngest orchestrator (importBatchFn) only uses Inngest for
 * coordination — short step.run calls to kick off a job and poll for
 * completion. The actual import work happens outside Inngest's step lifecycle
 * entirely, so HTTP timeouts don't apply.
 *
 * Durability note: if the worker crashes mid-job, the import is lost. The
 * uploaded_files.import_started_at column serves as a DB-level lock with a
 * 60-minute expiry — after that, a manual retry (re-click Import) can pick
 * up the orphaned file. Multi-instance resilience is not a concern yet
 * because Railway runs a single instance.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadedFiles } from '@/db/schema';
import { processFileImport } from '@/inngest/functions/importFile';

// In-process dedup set. Belt-and-suspenders against the same kickoff HTTP
// firing twice in rapid succession. The DB-level lock in processFileImport
// is the real protection; this just avoids two sibling Promises racing to
// acquire the same lock.
const inflight = new Set<string>();

export function startImportJob(uploadedFileId: string): { started: boolean; reason?: string } {
  if (inflight.has(uploadedFileId)) {
    return { started: false, reason: 'already-inflight' };
  }
  inflight.add(uploadedFileId);

  // Detach — don't await. The Promise runs in background; the HTTP caller
  // gets an immediate response. Errors are handled here: on failure we mark
  // the file `import_failed` so the orchestrator's poll sees it.
  (async () => {
    try {
      await processFileImport({ uploadedFileId });
      console.log(`[job] import-file ${uploadedFileId.slice(0, 8)} ok`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[job] import-file ${uploadedFileId.slice(0, 8)} failed:`, msg);
      try {
        await db
          .update(uploadedFiles)
          .set({
            validationStatus: 'import_failed',
            validationErrorsJson: { error: msg },
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
    }
  })();

  return { started: true };
}
