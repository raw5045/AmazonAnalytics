/**
 * CLI: fit the rank-to-volume power-law model for a given month.
 *
 * Thin wrapper around `runFitOrchestration` in
 * `lib/volumeModel/fitOrchestrator.ts`. Same fit logic is also used by
 * the combined-upload Inngest worker (worker/calibrationJobs.ts),
 * which always runs it as a dry-run.
 *
 * DRY-RUN by default: computes the fit + the full validation report
 * and writes NOTHING. Pass `--persist` to record the run to
 * model_calibration_runs — the owner-gated go-live step (detail pages
 * read the new fit immediately; kcs picks it up at the next weekly
 * refresh).
 *
 * Usage:
 *   pnpm tsx scripts/fitVolumeModel.ts <month-end-date> [--notes "free text"] [--persist]
 *
 * Examples:
 *   pnpm tsx scripts/fitVolumeModel.ts 2026-06-30 --notes "First SQP fit"          # dry-run
 *   pnpm tsx scripts/fitVolumeModel.ts 2026-06-30 --notes "June go-live" --persist # go live
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import {
  runFitOrchestration,
  FitInsufficientDataError,
} from '@/lib/volumeModel/fitOrchestrator';

function parseArgs(): { monthEndDate: string; notes: string | null; persist: boolean } {
  const args = process.argv.slice(2);
  const monthEndDate = args[0];
  if (!monthEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(monthEndDate)) {
    console.error(
      'Usage: pnpm tsx scripts/fitVolumeModel.ts <YYYY-MM-DD> [--notes "text"] [--persist]',
    );
    process.exit(1);
  }
  const nIdx = args.indexOf('--notes');
  const rawNotes = nIdx >= 0 ? args[nIdx + 1] : null;
  // Don't let a flag (e.g. a value-less `--notes --persist`) become the note.
  const notes = rawNotes && !rawNotes.startsWith('--') ? rawNotes : null;
  const persist = args.includes('--persist');
  return { monthEndDate, notes, persist };
}

function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '   —';
  return `${(p * 100).toFixed(1)}%`.padStart(7);
}

/** New÷production level ratio, e.g. `×0.55 (−45%)`. */
function fmtRatio(r: number): string {
  if (!Number.isFinite(r)) return '—';
  const pct = (r - 1) * 100;
  return `×${r.toFixed(2)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%)`;
}

async function main() {
  const { monthEndDate, notes, persist } = parseArgs();

  console.log(
    `\n=== Fitting rank→volume model for ${monthEndDate} ${persist ? '(PERSIST — go-live)' : '(DRY RUN)'} ===\n`,
  );
  try {
    const r = await runFitOrchestration({ monthEndDate, notes, persist });
    const nSqpPairs = r.nPairs - r.nPoeHeadPairs;

    console.log(`Calibration pairs:`);
    console.log(`  Before category filter: ${r.nPairsBeforeFilter.toLocaleString()}`);
    console.log(
      `  After filter:           ${r.nPairs.toLocaleString()} (${r.nExcludedByCategory.toLocaleString()} excluded by category)`,
    );
    console.log(`  SQP (primary):          ${nSqpPairs.toLocaleString()}`);
    console.log(`  POE head supplements:   ${r.nPoeHeadPairs.toLocaleString()}`);
    console.log(`  Training set:           ${r.nTraining.toLocaleString()}`);
    console.log(`  Holdout set:            ${r.nHoldout.toLocaleString()}`);
    console.log(`  Outliers trimmed:       ${r.nDroppedAsOutliers.toLocaleString()}`);

    console.log(`\nFit (${r.durationMs}ms):`);
    console.log(`  Best β (head segment):  ${r.beta.toFixed(4)}`);
    console.log(
      `  Scale factor (A):       ${r.scaleFactor.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    );
    console.log(
      `  Anchor (SQP):           rank ${r.anchor.rank.toLocaleString()} → ${r.anchor.volume.toLocaleString()}/mo`,
    );
    console.log(
      `  Implied rank-1 volume:  ${Math.round(r.impliedRank1Volume).toLocaleString()}/mo (extrapolated top of curve — gut-check)`,
    );

    console.log(`\nValidation MAPE on holdout (${r.nHoldout} pairs):`);
    console.log(`  Overall:         ${fmtPct(r.mapeOverall)}`);
    console.log(`  Top 1k:          ${fmtPct(r.mapeTop1k)}`);
    console.log(`  1k–10k:          ${fmtPct(r.mape1k10k)}`);
    console.log(`  10k–100k:        ${fmtPct(r.mape10k100k)}`);
    console.log(`  100k+:           ${fmtPct(r.mapeAbove100k)}`);

    console.log(`\nvs POE (validation — different source units; expected worse):`);
    if (r.poeValidation === null) {
      console.log(`  (no POE pairs for this month)`);
    } else {
      console.log(`  Overall:         ${fmtPct(r.poeValidation.overall)}`);
      console.log(`  Top 1k:          ${fmtPct(r.poeValidation.top1k)}`);
      console.log(`  1k–10k:          ${fmtPct(r.poeValidation.rank1kTo10k)}`);
      console.log(`  10k–100k:        ${fmtPct(r.poeValidation.rank10kTo100k)}`);
      console.log(`  100k+:           ${fmtPct(r.poeValidation.above100k)}`);
      if (r.nPoeHeadPairs > 0) {
        console.log(
          `  (note: the ${r.nPoeHeadPairs} POE head pair${r.nPoeHeadPairs === 1 ? '' : 's'} admitted to training also appear${r.nPoeHeadPairs === 1 ? 's' : ''} in this set)`,
        );
      }
    }

    console.log(`\nLevel vs current production fit (new ÷ prod):`);
    if (r.levelDeltaVsProduction === null) {
      console.log(`  —  (no production fit to compare)`);
    } else {
      console.log(`  Top 1k:          ${fmtRatio(r.levelDeltaVsProduction.top1k)}`);
      console.log(`  1k–10k:          ${fmtRatio(r.levelDeltaVsProduction.rank1kTo10k)}`);
      console.log(`  10k–100k:        ${fmtRatio(r.levelDeltaVsProduction.rank10kTo100k)}`);
      console.log(`  100k+:           ${fmtRatio(r.levelDeltaVsProduction.above100k)}`);
    }

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

    if (r.persisted) {
      console.log(
        `\nPERSISTED — run ${r.runId} is now the production fit (detail pages immediately; kcs at next weekly refresh).`,
      );
    } else {
      console.log(`\nDRY RUN — nothing persisted. Re-run with --persist to go live.`);
    }
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
