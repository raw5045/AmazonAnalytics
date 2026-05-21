/**
 * Inngest orchestrator for combined BA + POE calibration uploads.
 *
 * Thin orchestrator (same pattern as enrichKeepaForWeek v2):
 *   1. step.run('start-job') — dispatches the detached pipeline
 *   2. step.waitForEvent('calibration/processed', timeout: 1h)
 *   3. step.run('send-email') — fires the result-summary email
 *
 * All real work lives in worker/calibrationJobs.ts (downloads from R2,
 * ingests both files, fits the model). The orchestrator only does
 * cheap orchestration — sub-second steps so Inngest's HTTP timeout
 * never matters.
 *
 * concurrency:{limit:1, key:event.data.jobKey} dedups in case the
 * same upload's process endpoint is hit twice in rapid succession.
 */
import { inngest } from '../client';
import { startCalibrationJob } from '@/worker/calibrationJobs';
import { sendCalibrationEmail } from '@/lib/notifications/sendCalibrationEmail';

interface CalibrationUploadedEvent {
  jobKey: string;
  baStorageKey: string;
  poeStorageKey: string;
  baFilename: string;
  poeFilename: string;
  monthEndDate: string;
}

export const processCalibrationUpload = inngest.createFunction(
  {
    id: 'process-calibration-upload',
    name: 'Process combined BA + POE calibration upload',
    concurrency: { limit: 1, key: 'event.data.jobKey' },
    retries: 0,
    triggers: [{ event: 'calibration/uploaded' }],
  },
  async ({ event, step }) => {
    const data = event.data as CalibrationUploadedEvent;

    await step.run('start-job', () => {
      const result = startCalibrationJob({
        jobKey: data.jobKey,
        baStorageKey: data.baStorageKey,
        poeStorageKey: data.poeStorageKey,
        baFilename: data.baFilename,
        poeFilename: data.poeFilename,
        monthEndDate: data.monthEndDate,
      });
      return { started: result.started, reason: result.reason ?? null };
    });

    // Wait up to 1h for the detached job to finish. Generous — typical
    // run is 5-15 minutes (BA ingest dominates).
    const completion = await step.waitForEvent('await-processed', {
      event: 'calibration/processed',
      if: `async.data.jobKey == "${data.jobKey}"`,
      timeout: '1h',
    });

    if (!completion) {
      await step.run('send-email-timeout', async () => {
        await sendCalibrationEmail({
          outcome: 'orphaned',
          monthEndDate: data.monthEndDate,
          baFilename: data.baFilename,
          poeFilename: data.poeFilename,
          errorMessage: 'Processing did not complete within 1h. Worker may have died — check Railway logs and Inngest dashboard.',
        });
      });
      return { ok: false, outcome: 'timeout' };
    }

    await step.run('send-email', async () => {
      const d = completion.data as {
        success: boolean;
        errorPhase?: string | null;
        error?: string | null;
        baResult?: { upserted: number } | null;
        poeResult?: { upserted: number } | null;
        fitResult?: {
          beta: number;
          scaleFactor: number;
          nPairs: number;
          mapeOverall: number | null;
          mapeTop1k: number | null;
          mape1k10k: number | null;
          mape10k100k: number | null;
          mapeAbove100k: number | null;
        } | null;
      };
      await sendCalibrationEmail({
        outcome: d.success ? 'completed' : 'failed',
        monthEndDate: data.monthEndDate,
        baFilename: data.baFilename,
        poeFilename: data.poeFilename,
        errorPhase: d.errorPhase ?? null,
        errorMessage: d.error ?? null,
        baRowsUpserted: d.baResult?.upserted ?? null,
        poeRowsUpserted: d.poeResult?.upserted ?? null,
        fit: d.fitResult ?? null,
      });
    });

    return {
      ok: (completion.data as { success: boolean })?.success ?? false,
      outcome: (completion.data as { success: boolean })?.success ? 'completed' : 'failed',
      monthEndDate: data.monthEndDate,
    };
  },
);
