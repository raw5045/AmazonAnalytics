/**
 * CLI: fit the rank-to-volume power-law model for a given month.
 *
 * Thin wrapper around `runFitOrchestration` in
 * `lib/volumeModel/fitOrchestrator.ts`. Same fit logic is also used by
 * the combined-upload Inngest worker (worker/calibrationJobs.ts).
 *
 * Usage:
 *   pnpm tsx scripts/fitVolumeModel.ts <month-end-date> [--notes "free text"]
 *
 * Example:
 *   pnpm tsx scripts/fitVolumeModel.ts 2026-04-30 --notes "First fit, April 2026"
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import {
  runFitOrchestration,
  FitInsufficientDataError,
} from '@/lib/volumeModel/fitOrchestrator';

function parseArgs(): { monthEndDate: string; notes: string | null } {
  const args = process.argv.slice(2);
  const monthEndDate = args[0];
  if (!monthEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(monthEndDate)) {
    console.error('Usage: pnpm tsx scripts/fitVolumeModel.ts <YYYY-MM-DD> [--notes "text"]');
    process.exit(1);
  }
  const nIdx = args.indexOf('--notes');
  const notes = nIdx >= 0 ? args[nIdx + 1] : null;
  return { monthEndDate, notes };
}

function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '   —';
  return `${(p * 100).toFixed(1)}%`.padStart(7);
}

async function main() {
  const { monthEndDate, notes } = parseArgs();

  console.log(`\n=== Fitting rank→volume model for ${monthEndDate} ===\n`);
  try {
    const r = await runFitOrchestration({ monthEndDate, notes });

    console.log(`Total pairs:      ${r.nPairs.toLocaleString()}`);
    console.log(`Training set:     ${r.nTraining.toLocaleString()}`);
    console.log(`Holdout set:      ${r.nHoldout.toLocaleString()}`);
    console.log(`\nFit (${r.durationMs}ms):`);
    console.log(`  Best β:              ${r.beta.toFixed(4)}`);
    console.log(
      `  Scale factor (A):    ${r.scaleFactor.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    );
    console.log(`\nValidation MAPE on holdout (${r.nHoldout} pairs):`);
    console.log(`  Overall:         ${fmtPct(r.mapeOverall)}`);
    console.log(`  Top 1k:          ${fmtPct(r.mapeTop1k)}`);
    console.log(`  1k–10k:          ${fmtPct(r.mape1k10k)}`);
    console.log(`  10k–100k:        ${fmtPct(r.mape10k100k)}`);
    console.log(`  100k+:           ${fmtPct(r.mapeAbove100k)}`);
    console.log(`\n✓ Saved to model_calibration_runs (id=${r.runId})`);

    if (r.mapeOverall === null) {
      console.log(`\n  (No overall MAPE — holdout may be empty.)`);
    } else if (r.mapeOverall > 1.0) {
      console.log(`\n  ⚠ Overall MAPE > 100% — model is barely useful. Investigate.`);
    } else if (r.mapeOverall > 0.5) {
      console.log(`\n  ⚠ Overall MAPE > 50% — usable for rough sizing only.`);
    } else if (r.mapeOverall > 0.3) {
      console.log(`\n  Acceptable: MAPE 30-50%. Good enough for "ballpark" decisions.`);
    } else {
      console.log(`\n  ✓ Strong: MAPE < 30%. Model is decision-grade.`);
    }
    console.log(
      `\n  The 1k-10k rank band is usually the most decision-relevant for this app.`,
    );
  } catch (e) {
    if (e instanceof FitInsufficientDataError) {
      console.error(`\nAborting: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
