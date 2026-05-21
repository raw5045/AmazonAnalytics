/**
 * Detached background runner for monthly BA SFR uploads from the in-app
 * upload UI. Mirrors the pattern in worker/jobs.ts (CSV imports) and
 * worker/keepaJobs.ts (Keepa enrichment) — Inngest function dispatches
 * a Promise that does the actual work outside step.run's HTTP timeout.
 *
 * Flow:
 *   1. User uploads file via /admin/upload-monthly-sfr
 *   2. Browser PUTs file directly to R2 via presigned URL
 *   3. UI calls /api/admin/monthly-sfr/process with the storage key
 *   4. That route fires `monthly-sfr/uploaded` Inngest event
 *   5. Inngest dispatches to this worker via processMonthlySfr function
 *   6. processMonthlySfr.step.run('start-job') calls startMonthlySfrJob
 *   7. This module streams the file from R2, ingests via core, fires
 *      `monthly-sfr/processed` event when done
 *   8. Inngest function's step.waitForEvent unblocks, sends email
 */
import { inngest } from '@/inngest/client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { ingestMonthlySfrFromStream } from '@/lib/monthlySfr/ingestCore';

const inflight = new Set<string>();

export interface StartMonthlySfrJobArgs {
  storageKey: string;
  monthEndDate: string;
  filename: string;
}

/**
 * Spawn the detached ingest Promise and return immediately. The Promise
 * fires `monthly-sfr/processed` event on completion (success or failure)
 * so the orchestrator's step.waitForEvent unblocks.
 */
export function startMonthlySfrJob(
  args: StartMonthlySfrJobArgs,
): { started: boolean; reason?: string } {
  if (inflight.has(args.storageKey)) {
    return { started: false, reason: 'already-inflight' };
  }
  inflight.add(args.storageKey);

  (async () => {
    let success = false;
    let errorMessage: string | null = null;
    let result: Awaited<ReturnType<typeof ingestMonthlySfrFromStream>> | null = null;

    try {
      console.log(
        `[monthly-sfr-job ${args.storageKey}] starting for month ${args.monthEndDate}`,
      );
      const stream = await downloadStreamFromR2(args.storageKey, {
        requestTimeoutMs: 120_000,
        inactivityTimeoutMs: 600_000, // 10 min — generous for large files
      });
      result = await ingestMonthlySfrFromStream(stream, args.monthEndDate, args.filename);
      success = true;
      console.log(
        `[monthly-sfr-job ${args.storageKey}] done: ${result.upserted.toLocaleString()} rows ` +
          `in ${((result.parseMs + result.upsertMs) / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      console.error(
        `[monthly-sfr-job ${args.storageKey}] failed:`,
        errorMessage,
      );
    } finally {
      inflight.delete(args.storageKey);
      try {
        await inngest.send({
          name: 'monthly-sfr/processed',
          data: {
            storageKey: args.storageKey,
            monthEndDate: args.monthEndDate,
            filename: args.filename,
            success,
            error: errorMessage,
            result: result
              ? {
                  totalRows: result.totalRows,
                  skippedRows: result.skippedRows,
                  uniqueTerms: result.uniqueTerms,
                  collapses: result.collapses,
                  upserted: result.upserted,
                  parseMs: result.parseMs,
                  upsertMs: result.upsertMs,
                }
              : null,
          },
        });
      } catch (sendErr) {
        console.error(
          `[monthly-sfr-job ${args.storageKey}] failed to fire completion event:`,
          sendErr,
        );
      }
    }
  })();

  return { started: true };
}
