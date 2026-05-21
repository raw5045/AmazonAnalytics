/**
 * Orchestrates the rank-to-volume model fit: fetches calibration pairs
 * for a month, splits 70/30 by volume decile, grid-searches β, validates
 * MAPE by rank band on holdout, persists the result to
 * model_calibration_runs.
 *
 * Used by:
 *   - scripts/fitVolumeModel.ts (CLI path, manual fit)
 *   - worker/calibrationJobs.ts (in-app upload path, fits automatically
 *     after a combined BA + POE upload)
 *
 * Returns the persisted run id + the full result for reporting (email,
 * console summary, UI surfacing).
 */
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

export interface FitOrchestrationResult {
  runId: string;
  calibrationMonthEndDate: string;
  beta: number;
  scaleFactor: number;
  nPairs: number;
  nTraining: number;
  nHoldout: number;
  mapeOverall: number | null;
  mapeTop1k: number | null;
  mape1k10k: number | null;
  mape10k100k: number | null;
  mapeAbove100k: number | null;
  durationMs: number;
}

export class FitInsufficientDataError extends Error {
  constructor(public readonly nPairs: number) {
    super(`Insufficient calibration pairs: ${nPairs} (need ≥ 20 for a meaningful fit)`);
    this.name = 'FitInsufficientDataError';
  }
}

/**
 * Run the full fit pipeline for a given month and write the result to
 * model_calibration_runs. Caller provides a pool (shared connection
 * lifecycle) or omits to let us manage our own.
 */
export async function runFitOrchestration(args: {
  monthEndDate: string;
  notes?: string | null;
  pool?: Pool;
}): Promise<FitOrchestrationResult> {
  const startedAt = Date.now();
  const ownPool = !args.pool;
  const pool =
    args.pool ??
    new Pool({
      connectionString: process.env.DATABASE_URL!,
      statement_timeout: 600_000,
    });

  try {
    const pairs = await fetchPairs(pool, args.monthEndDate);
    if (pairs.length < 20) {
      throw new FitInsufficientDataError(pairs.length);
    }

    const { train, holdout } = stratifiedSplit(pairs);
    const fit = gridSearchBeta(train, { minBeta: 0.4, maxBeta: 1.2, step: 0.025 });
    const mapeOverallRes = meanAbsolutePercentageError(holdout, fit.beta, fit.scaleFactor);
    const stratified = stratifiedMape(holdout, fit.beta, fit.scaleFactor);

    const runId = await recordRun(pool, {
      calibrationMonthEndDate: args.monthEndDate,
      beta: fit.beta,
      scaleFactor: fit.scaleFactor,
      nTraining: train.length,
      nHoldout: holdout.length,
      mapeOverall: stratified.overall,
      mapeTop1k: stratified.top1k,
      mape1k10k: stratified.rank1kTo10k,
      mape10k100k: stratified.rank10kTo100k,
      mapeAbove100k: stratified.above100k,
      notes: args.notes ?? null,
    });

    // Mute "unused but useful for debugging" warning
    void mapeOverallRes;

    return {
      runId,
      calibrationMonthEndDate: args.monthEndDate,
      beta: fit.beta,
      scaleFactor: fit.scaleFactor,
      nPairs: pairs.length,
      nTraining: train.length,
      nHoldout: holdout.length,
      mapeOverall: stratified.overall,
      mapeTop1k: stratified.top1k,
      mape1k10k: stratified.rank1kTo10k,
      mape10k100k: stratified.rank10kTo100k,
      mapeAbove100k: stratified.above100k,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (ownPool) await pool.end();
  }
}

async function fetchPairs(pool: Pool, monthEndDate: string): Promise<Pair[]> {
  const c = await pool.connect();
  try {
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
 * distribution in both halves.
 */
function stratifiedSplit(pairs: Pair[]): { train: Pair[]; holdout: Pair[] } {
  if (pairs.length < 10) {
    const cut = Math.floor(pairs.length * 0.7);
    return { train: pairs.slice(0, cut), holdout: pairs.slice(cut) };
  }
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
