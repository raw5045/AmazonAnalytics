/**
 * Fit the rank-to-volume power-law model using calibration pairs.
 *
 * Loads (rank, volume) pairs from monthly_sfr ⋈ poe_calibration_data
 * for a given month, splits 70/30 train/holdout (stratified by volume
 * decile to keep both halves representative across the range), grid-
 * searches β over [0.4, 1.2], picks the β that minimizes log-space SSE
 * on training, then reports MAPE by rank band on the holdout set.
 *
 * Writes a row to model_calibration_runs with the fitted parameters
 * and validation metrics. The latest row is read by refreshSummary
 * (T7) to populate kcs.estimated_*_volume_current.
 *
 * Usage:
 *   pnpm tsx scripts/fitVolumeModel.ts <month-end-date> [--notes "free text"]
 *
 * Example:
 *   pnpm tsx scripts/fitVolumeModel.ts 2026-04-30 --notes "After April POE pull"
 *
 * Plan reference: docs/superpowers/plans/2026-05-19-search-volume-estimator.md (T4)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
import {
  gridSearchBeta,
  meanAbsolutePercentageError,
  stratifiedMape,
} from '@/lib/analytics/volumeModel';

interface Pair {
  rank: number;
  volume: number;
}

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

async function fetchPairs(pool: Pool, monthEndDate: string): Promise<Pair[]> {
  const c = await pool.connect();
  try {
    // Join monthly_sfr ⋈ poe_calibration_data on BOTH normalized term AND
    // month_end_date — POE now has a month dimension, so we want the
    // monthly snapshot that matches our BA report month.
    const { rows } = await c.query<{ actual_rank: number; poe_30_day_volume: string }>(
      `
      SELECT m.actual_rank, p.poe_30_day_volume::text AS poe_30_day_volume
      FROM monthly_sfr m
      JOIN poe_calibration_data p
        ON p.search_term_normalized = m.search_term_normalized
       AND p.month_end_date = m.month_end_date
      WHERE m.month_end_date = $1::date
        AND m.actual_rank > 0
        AND p.poe_30_day_volume > 0
      `,
      [monthEndDate],
    );
    return rows.map((r) => ({
      rank: r.actual_rank,
      volume: Number(r.poe_30_day_volume),
    }));
  } finally {
    c.release();
  }
}

/**
 * Stratified train/test split by volume decile. Each decile contributes
 * its first ~70% (deterministic — sorted by volume within decile) to
 * train and the remaining ~30% to test. Preserves the volume
 * distribution in both halves so we don't accidentally test only on
 * high-volume terms.
 */
function stratifiedSplit(pairs: Pair[]): { train: Pair[]; holdout: Pair[] } {
  if (pairs.length < 10) {
    // Too few pairs for stratified split; just do a 70/30 by index
    const cut = Math.floor(pairs.length * 0.7);
    return { train: pairs.slice(0, cut), holdout: pairs.slice(cut) };
  }
  // Sort by volume ascending, then bucket into deciles
  const sorted = [...pairs].sort((a, b) => a.volume - b.volume);
  const train: Pair[] = [];
  const holdout: Pair[] = [];
  const perDecile = Math.ceil(sorted.length / 10);
  for (let d = 0; d < 10; d++) {
    const bucket = sorted.slice(d * perDecile, (d + 1) * perDecile);
    const cut = Math.max(1, Math.floor(bucket.length * 0.7));
    for (let i = 0; i < bucket.length; i++) {
      if (i < cut) train.push(bucket[i]);
      else holdout.push(bucket[i]);
    }
  }
  return { train, holdout };
}

async function recordRun(
  pool: Pool,
  args: {
    calibrationMonthEndDate: string;
    beta: number;
    scaleFactor: number;
    nTraining: number;
    nHoldout: number;
    mapeOverall: number | null;
    mapeTop1k: number | null;
    mape1k10k: number | null;
    mape10k100k: number | null;
    mapeAbove100k: number | null;
    notes: string | null;
  },
): Promise<string> {
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{ id: string }>(
      `
      INSERT INTO model_calibration_runs (
        calibration_month_end_date, beta, scale_factor,
        n_training_keywords, n_holdout_keywords,
        mape_overall, mape_top_1k, mape_1k_10k, mape_10k_100k, mape_above_100k,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
      `,
      [
        args.calibrationMonthEndDate,
        args.beta.toFixed(4),
        args.scaleFactor.toFixed(6),
        args.nTraining,
        args.nHoldout,
        args.mapeOverall !== null ? (args.mapeOverall * 100).toFixed(2) : null,
        args.mapeTop1k !== null ? (args.mapeTop1k * 100).toFixed(2) : null,
        args.mape1k10k !== null ? (args.mape1k10k * 100).toFixed(2) : null,
        args.mape10k100k !== null ? (args.mape10k100k * 100).toFixed(2) : null,
        args.mapeAbove100k !== null ? (args.mapeAbove100k * 100).toFixed(2) : null,
        args.notes,
      ],
    );
    return rows[0].id;
  } finally {
    c.release();
  }
}

function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '   —';
  return `${(p * 100).toFixed(1)}%`.padStart(7);
}

async function main() {
  const { monthEndDate, notes } = parseArgs();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

  try {
    const pairs = await fetchPairs(pool, monthEndDate);
    if (pairs.length === 0) {
      console.error(`No calibration pairs for ${monthEndDate}. Aborting.`);
      process.exit(1);
    }
    if (pairs.length < 20) {
      console.error(
        `Only ${pairs.length} calibration pair(s) available. Need ≥20 for a meaningful fit. Aborting.`,
      );
      process.exit(1);
    }

    console.log(`\n=== Fitting rank→volume model for ${monthEndDate} ===\n`);
    console.log(`Total pairs:      ${pairs.length.toLocaleString()}`);

    const { train, holdout } = stratifiedSplit(pairs);
    console.log(`Training set:     ${train.length.toLocaleString()}`);
    console.log(`Holdout set:      ${holdout.length.toLocaleString()}`);

    const t0 = Date.now();
    const fit = gridSearchBeta(train, { minBeta: 0.4, maxBeta: 1.2, step: 0.025 });
    const tFit = Date.now() - t0;

    console.log(`\nGrid search (β ∈ [0.40, 1.20] step 0.025): ${tFit}ms`);
    console.log(`  Best β:              ${fit.beta.toFixed(4)}`);
    console.log(`  Scale factor (A):    ${fit.scaleFactor.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`  Log-space SSE:       ${fit.sse.toFixed(4)} on ${fit.nUsed} training pairs`);

    // Evaluate on holdout
    const overallMape = meanAbsolutePercentageError(holdout, fit.beta, fit.scaleFactor);
    const stratified = stratifiedMape(holdout, fit.beta, fit.scaleFactor);

    console.log(`\nValidation MAPE on holdout (${holdout.length} pairs):`);
    console.log(
      `  Overall:         ${fmtPct(stratified.overall)}  (n=${stratified.counts.overall})`,
    );
    console.log(
      `  Top 1k:          ${fmtPct(stratified.top1k)}  (n=${stratified.counts.top1k})`,
    );
    console.log(
      `  1k–10k:          ${fmtPct(stratified.rank1kTo10k)}  (n=${stratified.counts.rank1kTo10k})`,
    );
    console.log(
      `  10k–100k:        ${fmtPct(stratified.rank10kTo100k)}  (n=${stratified.counts.rank10kTo100k})`,
    );
    console.log(
      `  100k+:           ${fmtPct(stratified.above100k)}  (n=${stratified.counts.above100k})`,
    );

    // Persist to model_calibration_runs. calibration_month_end_date is the
    // SAME as monthEndDate (the month whose calibration data we used).
    // pickFitForWeek uses this to decide which fit applies to each week.
    const runId = await recordRun(pool, {
      calibrationMonthEndDate: monthEndDate,
      beta: fit.beta,
      scaleFactor: fit.scaleFactor,
      nTraining: train.length,
      nHoldout: holdout.length,
      mapeOverall: stratified.overall,
      mapeTop1k: stratified.top1k,
      mape1k10k: stratified.rank1kTo10k,
      mape10k100k: stratified.rank10kTo100k,
      mapeAbove100k: stratified.above100k,
      notes,
    });

    console.log(`\n✓ Saved to model_calibration_runs (id=${runId})`);
    console.log(`\nQuick interpretation:`);
    if (overallMape.mape > 1.0) {
      console.log(`  ⚠ Overall MAPE > 100% — model is barely useful. Investigate.`);
    } else if (overallMape.mape > 0.5) {
      console.log(`  ⚠ Overall MAPE > 50% — usable for rough sizing only.`);
    } else if (overallMape.mape > 0.3) {
      console.log(`  Acceptable: MAPE 30-50%. Good enough for "ballpark" decisions.`);
    } else {
      console.log(`  ✓ Strong: MAPE < 30%. Model is decision-grade.`);
    }
    console.log(
      `\n  The 1k-10k rank band is usually the most decision-relevant for this app.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
