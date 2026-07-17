/**
 * Detached background runner for combined calibration uploads from the
 * in-app UI (BA + POE and/or SQP). Does the whole pipeline in one go:
 *
 *   1. Download monthly BA CSV from R2 → ingest into monthly_sfr
 *   2. Download POE CSV from R2 (when present) → ingest into
 *      poe_calibration_data (validation data — POE no longer trains)
 *   3. Download SQP CSV from R2 (when present) → ingest into
 *      sqp_calibration_data (the training source; spec 2026-07-16)
 *   4. When the upload included an SQP file: DRY-RUN fit of the
 *      rank-to-volume model — computes the full report, writes NOTHING.
 *      Go-live is the owner-gated `scripts/fitVolumeModel.ts --persist`.
 *      POE-only uploads just store validation data (no fit).
 *   5. Fire `calibration/processed` event with results (success or failure)
 *
 * Mirrors the worker/monthlySfrJobs.ts pattern but bundles the steps
 * into one job — the user uploaded the files together, the report they
 * want covers the whole set, so we ingest + fit atomically.
 *
 * Errors are caught per-phase so we can report exactly where it failed
 * (e.g., "BA ingest succeeded, SQP ingest failed with X").
 */
import { Pool } from 'pg';
import { inngest } from '@/inngest/client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { ingestMonthlySfrFromStream } from '@/lib/monthlySfr/ingestCore';
import { ingestPoeCalibrationFromStream } from '@/lib/poeCalibration/ingestCore';
import { ingestSqpCalibrationFromStream } from '@/lib/sqpCalibration/ingestCore';
import {
  runFitOrchestration,
  FitInsufficientDataError,
} from '@/lib/volumeModel/fitOrchestrator';

const inflight = new Set<string>();

export interface StartCalibrationJobArgs {
  jobKey: string; // unique per upload — used as the concurrency key + dedup
  baStorageKey: string;
  poeStorageKey: string | null;
  sqpStorageKey: string | null;
  baFilename: string;
  poeFilename: string | null;
  sqpFilename: string | null;
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

    let phase: 'ba' | 'poe' | 'sqp' | 'fit' | 'done' = 'ba';
    let success = false;
    let errorMessage: string | null = null;
    let baResult: Awaited<ReturnType<typeof ingestMonthlySfrFromStream>> | null = null;
    let poeResult: Awaited<ReturnType<typeof ingestPoeCalibrationFromStream>> | null = null;
    let sqpResult: Awaited<ReturnType<typeof ingestSqpCalibrationFromStream>> | null = null;
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

      // Phase 2: POE ingest (validation data — POE no longer trains)
      if (args.poeStorageKey && args.poeFilename) {
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
      }

      // Phase 3: SQP ingest (the training source; spec 2026-07-16)
      if (args.sqpStorageKey && args.sqpFilename) {
        phase = 'sqp';
        log(`phase=sqp — streaming ${args.sqpFilename} from R2`);
        const sqpStream = await downloadStreamFromR2(args.sqpStorageKey, {
          requestTimeoutMs: 120_000,
          inactivityTimeoutMs: 600_000,
        });
        sqpResult = await ingestSqpCalibrationFromStream(
          sqpStream,
          args.monthEndDate,
          args.sqpFilename,
          pool,
        );
        log(
          `phase=sqp done: ${sqpResult.upserted.toLocaleString()} rows upserted ` +
            `(${sqpResult.uniqueTerms.toLocaleString()} unique terms)`,
        );
        if (sqpResult.monthMismatchWarning) {
          log(`phase=sqp WARNING: ${sqpResult.monthMismatchWarning}`);
        }
      }

      // Phase 4: dry-run fit — only when the upload included an SQP
      // file (SQP trains the model; a POE-only upload just stores
      // validation data). Computes the full report, persists NOTHING —
      // go-live is the owner-gated `scripts/fitVolumeModel.ts --persist`.
      if (args.sqpStorageKey && args.sqpFilename) {
        phase = 'fit';
        log(`phase=fit — dry-run fit on ${args.monthEndDate} pairs`);
        fitResult = await runFitOrchestration({
          monthEndDate: args.monthEndDate,
          notes: `Combined upload (${[args.baFilename, args.poeFilename, args.sqpFilename]
            .filter(Boolean)
            .join(' + ')})`,
          pool,
          persist: false,
        });
        log(
          `phase=fit done (DRY RUN — not persisted): β=${fitResult.beta.toFixed(4)}, ` +
            `A=${fitResult.scaleFactor.toFixed(0)}, ` +
            `${fitResult.nPairs} pairs (${fitResult.nTraining} train + ${fitResult.nHoldout} holdout, ` +
            `${fitResult.nPoeHeadPairs} POE head), ` +
            `anchor rank ${fitResult.anchor.rank}, ` +
            `MAPE overall=${fitResult.mapeOverall !== null ? (fitResult.mapeOverall * 100).toFixed(1) + '%' : 'n/a'}`,
        );
      } else {
        log(`no SQP file — POE-only upload stores validation data; skipping fit (SQP trains the model)`);
      }

      phase = 'done';
      success = true;
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      if (e instanceof FitInsufficientDataError) {
        log(`phase=${phase} failed: insufficient SQP pairs (${e.nPairs}; need ≥ 20) — no model fit. Ingests are committed.`);
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
            sqpResult,
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
