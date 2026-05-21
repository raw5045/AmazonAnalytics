/**
 * Pure functions for the rank-to-volume model.
 *
 * The model is a single-parameter power law:
 *   volume(rank) = A × rank^-β
 * where:
 *   - β (beta) is the rank-decay exponent (typically 0.5-1.0 for Amazon
 *     search distributions). Higher β = volume falls off faster as
 *     rank increases.
 *   - A (scale_factor) is the constant chosen so volume(rank=1) = A.
 *
 * The fit is in log-log space:
 *   log(volume) = log(A) - β × log(rank)
 * which is linear in log(A) and -β. We grid-search β over a plausible
 * range, then derive log(A) as the residual mean to minimize log-space
 * squared error.
 *
 * Why log-space:
 *   - Search volumes are lognormal (top keywords have 100,000× more
 *     volume than the long tail). Fitting in raw volume space lets
 *     top-1K keywords dominate the loss and ignores everything else.
 *   - Log-space treats a 10× error at any rank the same way — the
 *     model performs uniformly across the rank range that matters.
 *
 * See `scripts/fitVolumeModel.ts` for the orchestration logic that
 * uses these functions on the calibration pairs.
 *
 * Plan reference: docs/superpowers/plans/2026-05-19-search-volume-estimator.md
 */

/**
 * Predict volume from rank given fitted (β, A).
 *
 * Returns 0 for rank ≤ 0 (defensive; ranks are 1-indexed).
 */
export function predictVolume(rank: number, beta: number, scaleFactor: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  if (!Number.isFinite(beta) || !Number.isFinite(scaleFactor)) return 0;
  return scaleFactor * Math.pow(rank, -beta);
}

/**
 * Given a calibration set of (rank, observed_volume) pairs and a
 * candidate β, compute the optimal log(A) that minimizes mean
 * squared error in log space.
 *
 * The closed-form solution:
 *   log(A) = mean( log(volume_i) + β × log(rank_i) )
 *
 * Pairs with non-positive rank or volume are skipped (can't take log).
 */
export function fitScaleFactorForBeta(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  beta: number,
): { scaleFactor: number; nUsed: number } {
  let logASum = 0;
  let nUsed = 0;
  for (const { rank, volume } of pairs) {
    if (rank <= 0 || volume <= 0) continue;
    // log(A) for this pair = log(volume) - log(rank^-β) = log(volume) + β×log(rank)
    logASum += Math.log(volume) + beta * Math.log(rank);
    nUsed += 1;
  }
  if (nUsed === 0) return { scaleFactor: 0, nUsed: 0 };
  const logA = logASum / nUsed;
  return { scaleFactor: Math.exp(logA), nUsed };
}

/**
 * Sum of squared errors in log space, for a given (β, A) over the
 * pair set. Lower = better fit. Used as the grid-search objective.
 */
export function logSpaceSSE(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  beta: number,
  scaleFactor: number,
): number {
  if (scaleFactor <= 0) return Infinity;
  const logA = Math.log(scaleFactor);
  let sse = 0;
  let nUsed = 0;
  for (const { rank, volume } of pairs) {
    if (rank <= 0 || volume <= 0) continue;
    // predicted log(vol) = log(A) - β × log(rank)
    const logPredicted = logA - beta * Math.log(rank);
    const logActual = Math.log(volume);
    const err = logPredicted - logActual;
    sse += err * err;
    nUsed += 1;
  }
  return nUsed === 0 ? Infinity : sse;
}

/**
 * Grid-search β over a range, picking the β with the lowest log-space
 * SSE. For each candidate β, fitScaleFactorForBeta gives the closed-
 * form-optimal log(A); we then evaluate the SSE at that pair.
 *
 * Returns the best (β, A) plus the SSE achieved.
 */
export function gridSearchBeta(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  options: {
    minBeta?: number;
    maxBeta?: number;
    step?: number;
  } = {},
): { beta: number; scaleFactor: number; sse: number; nUsed: number } {
  const minBeta = options.minBeta ?? 0.4;
  const maxBeta = options.maxBeta ?? 1.2;
  const step = options.step ?? 0.025;
  if (minBeta >= maxBeta) throw new Error('minBeta must be < maxBeta');
  if (step <= 0) throw new Error('step must be > 0');

  let bestBeta = minBeta;
  let bestScale = 0;
  let bestSse = Infinity;
  let lastNUsed = 0;
  // Use integer iteration to avoid float-accumulation drift across
  // many steps. (minBeta + step*k) gives stable β values.
  const nSteps = Math.floor((maxBeta - minBeta) / step) + 1;
  for (let k = 0; k < nSteps; k++) {
    const beta = minBeta + k * step;
    const { scaleFactor, nUsed } = fitScaleFactorForBeta(pairs, beta);
    if (scaleFactor <= 0) continue;
    const sse = logSpaceSSE(pairs, beta, scaleFactor);
    if (sse < bestSse) {
      bestBeta = beta;
      bestScale = scaleFactor;
      bestSse = sse;
      lastNUsed = nUsed;
    }
  }
  return { beta: bestBeta, scaleFactor: bestScale, sse: bestSse, nUsed: lastNUsed };
}

/**
 * Mean absolute percentage error (MAPE) of predictions vs observed.
 * Computed on raw volumes (not log space) so the user-facing number
 * matches intuition: "predictions are typically off by X%".
 *
 * MAPE = mean( |predicted - actual| / actual )
 *
 * Pairs with non-positive actual volume are skipped (avoids ÷0).
 */
export function meanAbsolutePercentageError(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  beta: number,
  scaleFactor: number,
): { mape: number; nUsed: number } {
  let sum = 0;
  let nUsed = 0;
  for (const { rank, volume } of pairs) {
    if (rank <= 0 || volume <= 0) continue;
    const predicted = predictVolume(rank, beta, scaleFactor);
    sum += Math.abs(predicted - volume) / volume;
    nUsed += 1;
  }
  return nUsed === 0 ? { mape: NaN, nUsed: 0 } : { mape: sum / nUsed, nUsed };
}

/**
 * Stratified MAPE: partition pairs by rank band, compute MAPE for each.
 * Lets us see whether the model is uniformly good or only good in some
 * regions (e.g., great on top-1K, terrible on 10K+).
 */
export function stratifiedMape(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  beta: number,
  scaleFactor: number,
): {
  overall: number | null;
  top1k: number | null;
  rank1kTo10k: number | null;
  rank10kTo100k: number | null;
  above100k: number | null;
  counts: { overall: number; top1k: number; rank1kTo10k: number; rank10kTo100k: number; above100k: number };
} {
  const buckets = {
    top1k: [] as Array<{ rank: number; volume: number }>,
    rank1kTo10k: [] as Array<{ rank: number; volume: number }>,
    rank10kTo100k: [] as Array<{ rank: number; volume: number }>,
    above100k: [] as Array<{ rank: number; volume: number }>,
  };
  for (const p of pairs) {
    if (p.rank <= 0 || p.volume <= 0) continue;
    if (p.rank <= 1_000) buckets.top1k.push(p);
    else if (p.rank <= 10_000) buckets.rank1kTo10k.push(p);
    else if (p.rank <= 100_000) buckets.rank10kTo100k.push(p);
    else buckets.above100k.push(p);
  }

  const overallResult = meanAbsolutePercentageError(pairs, beta, scaleFactor);
  const m = (b: Array<{ rank: number; volume: number }>) => {
    if (b.length === 0) return null;
    const r = meanAbsolutePercentageError(b, beta, scaleFactor);
    return Number.isFinite(r.mape) ? r.mape : null;
  };

  return {
    overall: Number.isFinite(overallResult.mape) ? overallResult.mape : null,
    top1k: m(buckets.top1k),
    rank1kTo10k: m(buckets.rank1kTo10k),
    rank10kTo100k: m(buckets.rank10kTo100k),
    above100k: m(buckets.above100k),
    counts: {
      overall: overallResult.nUsed,
      top1k: buckets.top1k.length,
      rank1kTo10k: buckets.rank1kTo10k.length,
      rank10kTo100k: buckets.rank10kTo100k.length,
      above100k: buckets.above100k.length,
    },
  };
}
