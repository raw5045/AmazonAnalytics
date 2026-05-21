/**
 * Inngest orchestrator for monthly BA SFR uploads from the in-app UI.
 *
 * Thin orchestrator (same shape as enrichKeepaForWeek's v2):
 *   1. step.run('start-job') — spawns detached Promise on the worker
 *   2. step.waitForEvent('monthly-sfr/processed', timeout: 1h)
 *   3. Logs completion (could send email later; v1 just logs)
 *
 * The real work (download from R2, stream-parse, dedup, INSERT) lives
 * in worker/monthlySfrJobs.ts and runs entirely outside step.run's
 * HTTP timeout window.
 *
 * concurrency:{limit:1, key:event.data.storageKey} prevents duplicate
 * processing of the same upload (which would just no-op via ON CONFLICT
 * DO UPDATE but still burn cycles).
 */
import { inngest } from '../client';
import { startMonthlySfrJob } from '@/worker/monthlySfrJobs';

interface MonthlySfrUploadedEvent {
  storageKey: string;
  monthEndDate: string;
  filename: string;
}

export const processMonthlySfr = inngest.createFunction(
  {
    id: 'process-monthly-sfr',
    name: 'Process uploaded monthly BA SFR CSV',
    concurrency: { limit: 1, key: 'event.data.storageKey' },
    retries: 0,
    triggers: [{ event: 'monthly-sfr/uploaded' }],
  },
  async ({ event, step }) => {
    const data = event.data as MonthlySfrUploadedEvent;

    await step.run('start-job', () => {
      const result = startMonthlySfrJob({
        storageKey: data.storageKey,
        monthEndDate: data.monthEndDate,
        filename: data.filename,
      });
      return { started: result.started, reason: result.reason ?? null };
    });

    // Wait for the detached job to fire completion. 1h timeout covers
    // even a slow 3M-row ingest (typical: 5-10 min).
    const completion = await step.waitForEvent('await-processed', {
      event: 'monthly-sfr/processed',
      if: `async.data.storageKey == "${data.storageKey}"`,
      timeout: '1h',
    });

    if (!completion) {
      return {
        ok: false,
        outcome: 'timeout',
        reason: 'Processing did not complete within 1h',
      };
    }

    return {
      ok: completion.data?.success ?? false,
      outcome: completion.data?.success ? 'completed' : 'failed',
      storageKey: data.storageKey,
      monthEndDate: data.monthEndDate,
      result: completion.data?.result ?? null,
      error: completion.data?.error ?? null,
    };
  },
);
