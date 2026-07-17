/**
 * Detached background runner for combined BA + POE calibration uploads
 * from the in-app UI. Does the whole pipeline in one go:
 *
 *   1. Download monthly BA CSV from R2 → ingest into monthly_sfr
 *   2. Download POE CSV from R2 → ingest into poe_calibration_data
 *   3. Fit the rank-to-volume model on the resulting calibration pairs
 *   4. Write the fitted model to model_calibration_runs
 *   5. Fire `calibration/processed` event with results (success or failure)
 *
 * Mirrors the worker/monthlySfrJobs.ts pattern but bundles all three
 * steps into one job — the user uploaded both files together, the
 * "map" they want is the fitted model, so we ingest + fit atomically.
 *
 * Errors are caught per-phase so we can report exactly where it failed
 * (e.g., "BA ingest succeeded, POE ingest failed at row 1247 with X").
 */
import { Pool } from 'pg';
import { inngest } from '@/inngest/client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { ingestMonthlySfrFromStream } from '@/lib/monthlySfr/ingestCore';
import { ingestPoeCalibrationFromStream } from '@/lib/poeCalibration/ingestCore';
import {
  runFitOrchestration,
  FitInsufficientDataError,
} from '@/lib/volumeModel/fitOrchestrator';

const inflight = new Set<string>();

export interface StartCalibrationJobArgs {
  jobKey: string; // unique per upload — used as the concurrency key + dedup
  baStorageKey: string;
  poeStorageKey: string;
  baFilename: string;
  poeFilename: string;
  monthEndDate: string;
}

/**
 * Spawn the detached calibration job. Returns immediately; the Promise
 * fires `calibration/processed` on completion (success or failure).
 */
export function startCalibrationJob(
  args: StartCalibrationJobArgs,
): { started: boolean; reason?: string } {
  if (inflight.has(args.jobKey)) {
    return { started: false, reason: 'already-inflight' };
  }
  inflight.add(args.jobKey);

  (async () => {
    const log = (msg: string) =>
      console.log(`[calibration ${args.jobKey.slice(0, 8)}] ${msg}`);

    let phase: 'ba' | 'poe' | 'fit' | 'done' = 'ba';
    let success = false;
    let errorMessage: string | null = null;
    let baResult: Awaited<ReturnType<typeof ingestMonthlySfrFromStream>> | null = null;
    let poeResult: Awaited<ReturnType<typeof ingestPoeCalibrationFromStream>> | null = null;
    let fitResult: Awaited<ReturnType<typeof runFitOrchestration>> | null = null;

    // Single shared pool across all phases. Saves on per-phase setup
    // and keeps DB connection lifecycle simple.
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL!,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 600_000,
      max: 4,
    });

    try {
      // Phase 1: BA ingest
      log(`phase=ba — streaming ${args.baFilename} from R2 for month ${args.monthEndDate}`);
      const baStream = await downloadStreamFromR2(args.baStorageKey, {
        requestTimeoutMs: 120_000,
        inactivityTimeoutMs: 600_000,
      });
      baResult = await ingestMonthlySfrFromStream(
        baStream,
        args.monthEndDate,
        args.baFilename,
        pool,
      );
      log(
        `phase=ba done: ${baResult.upserted.toLocaleString()} rows upserted, ` +
          `${baResult.collapses} collapses`,
      );

      // Phase 2: POE ingest
      phase = 'poe';
      log(`phase=poe — streaming ${args.poeFilename} from R2`);
      const poeStream = await downloadStreamFromR2(args.poeStorageKey, {
        requestTimeoutMs: 120_000,
        inactivityTimeoutMs: 600_000,
      });
      poeResult = await ingestPoeCalibrationFromStream(
        poeStream,
        args.monthEndDate,
        args.poeFilename,
        pool,
      );
      log(
        `phase=poe done: ${poeResult.upserted.toLocaleString()} rows upserted, ` +
          `${poeResult.collapses} collapses`,
      );

      // Phase 3: fit
      phase = 'fit';
      log(`phase=fit — fitting model on ${args.monthEndDate} pairs`);
      fitResult = await runFitOrchestration({
        monthEndDate: args.monthEndDate,
        notes: `Combined upload (${args.baFilename} + ${args.poeFilename})`,
        pool,
        // Stopgap — Task 4/5 of the SQP plan own this call site.
        persist: true,
      });
      log(
        `phase=fit done: β=${fitResult.beta.toFixed(4)}, A=${fitResult.scaleFactor.toFixed(0)}, ` +
          `${fitResult.nPairs} pairs (${fitResult.nTraining} train + ${fitResult.nHoldout} holdout), ` +
          `MAPE overall=${fitResult.mapeOverall !== null ? (fitResult.mapeOverall * 100).toFixed(1) + '%' : 'n/a'}`,
      );

      phase = 'done';
      success = true;
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      if (e instanceof FitInsufficientDataError) {
        log(`phase=${phase} failed: insufficient pairs (${e.nPairs}) — no model fit. BA/POE ingests are committed.`);
      } else {
        log(`phase=${phase} failed: ${errorMessage}`);
      }
    } finally {
      inflight.delete(args.jobKey);
      try {
        await pool.end();
      } catch (poolErr) {
        log(`pool teardown failed: ${(poolErr as Error).message}`);
      }
      // Fire completion event so the orchestrator's waitForEvent unblocks.
      try {
        await inngest.send({
          name: 'calibration/processed',
          data: {
            jobKey: args.jobKey,
            monthEndDate: args.monthEndDate,
            success,
            errorPhase: success ? null : phase,
            error: errorMessage,
            baResult,
            poeResult,
            fitResult,
          },
        });
      } catch (sendErr) {
        log(`failed to fire completion event: ${(sendErr as Error).message}`);
      }
    }
  })();

  return { started: true };
}
