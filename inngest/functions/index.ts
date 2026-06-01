import { rubricUploadedFn } from './rubric';
import { validateFileFn } from './validate';
import { importBatchFn } from './importBatch';
import { enrichKeepaForWeek } from './enrichKeepaForWeek';
import { processMonthlySfr } from './processMonthlySfr';
import { processCalibrationUpload } from './processCalibrationUpload';
import { syncKcsKeepaAggregates } from './syncKcsKeepaAggregates';
import { sendWeeklyDigestFn } from './sendWeeklyDigest';

// Note: `importFileFn` is no longer registered. The batch path
// (importBatchFn) now calls processFileImport directly via the worker's
// in-process job runner (worker/jobs.ts), bypassing Inngest's HTTP
// invocation timeout. See inngest/functions/importBatch.ts for rationale.

export const functions = [
  rubricUploadedFn,
  validateFileFn,
  importBatchFn,
  enrichKeepaForWeek,
  processMonthlySfr,
  processCalibrationUpload,
  syncKcsKeepaAggregates,
  sendWeeklyDigestFn,
];
