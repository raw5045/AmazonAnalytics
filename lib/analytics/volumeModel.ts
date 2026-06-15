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
 * Time-aware model selection.
 *
 * Each fit is associated with a calibration_month_end_date (the month
 * whose POE + BA data trained it). For any given week W, we want the
 * fit whose calibration_month_end_date is the MAX value ≤ end-of-W's-
 * month. (Most-recent-past-or-equal — never use a future month's fit
 * for an earlier week, since the total-volume scale factor genuinely
 * shifts with season.)
 *
 * Fall-back: if no fits qualify (week is before our earliest fit),
 * use the earliest available fit and flag `isExtrapolated: true` so
 * the UI can render a "extrapolated" tooltip.
 *
 * Tiebreaker for multiple fits in the same calibration month: prefer
 * the latest `fittedAt` (a re-fit within the same month overrides
 * the older one).
 */
/**
 * Per-segment fit data. A single-segment fit has one of these; a
 * piecewise fit has N segments separated by N-1 breakpoints. See
 * PiecewiseFit below.
 */
export interface FitSegment {
  beta: number;
  scaleFactor: number;
}

/**
 * Full structured fit. Either a single power-law segment OR a
 * piecewise N-segment power law with N-1 breakpoints. Continuity
 * between segments is enforced at fit time (A_{n+1} = A_n × K_n^{β_{n+1} - β_n}).
 *
 * - `segments.length === 1`  ⇒ single power law, no breakpoints
 * - `segments.length >= 2`   ⇒ piecewise, breakpoints sorted ascending
 *
 * The applied segment for a given rank R is segments[i] where i is
 * the smallest index such that R ≤ breakpoints[i] (or the last
 * segment if R exceeds every breakpoint).
 */
export interface PiecewiseFit {
  /**
   * Sorted ascending. Length = segments.length - 1. Empty for
   * single-segment fits.
   */
  breakpoints: number[];
  segments: FitSegment[];
}

export interface FitParams extends PiecewiseFit {
  /** Month whose data trained this fit (ISO date YYYY-MM-DD). */
  calibrationMonthEndDate: string;
  /** When this fit was computed (ISO timestamp). Tiebreaker. */
  fittedAt: string;
  /**
   * Convenience: equals segments[0].beta. Kept for backward compat
   * with callers that read a flat (β, A) before piecewise existed.
   * Always references the FIRST (head) segment.
   */
  beta: number;
  /**
   * Convenience: equals segments[0].scaleFactor. Kept for backward
   * compat (see above).
   */
  scaleFactor: number;
}

/**
 * Predict volume from rank using a possibly-piecewise fit.
 *
 * - Single segment (no breakpoints): equivalent to predictVolume.
 * - Piecewise: dispatches to the segment whose range covers `rank`.
 *
 * Returns 0 for invalid input (defensive).
 */
export function predictVolumeFromFit(rank: number, fit: PiecewiseFit): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  if (fit.segments.length === 0) return 0;
  for (let i = 0; i < fit.breakpoints.length; i++) {
    if (rank <= fit.breakpoints[i]) {
      return predictVolume(rank, fit.segments[i].beta, fit.segments[i].scaleFactor);
    }
  }
  const last = fit.segments[fit.segments.length - 1];
  return predictVolume(rank, last.beta, last.scaleFactor);
}

export interface FitSelection {
  fit: FitParams;
  /**
   * True when we fell back to the earliest-fit because no qualifying
   * past-or-equal fit was found. UI shows a tooltip in this case.
   */
  isExtrapolated: boolean;
}

/**
 * Pick the best fit for a given week. Returns null only when `fits`
 * is empty (no calibration runs have happened yet).
 */
export function pickFitForWeek(
  weekEndDate: string,
  fits: ReadonlyArray<FitParams>,
): FitSelection | null {
  if (fits.length === 0) return null;

  const monthEnd = endOfMonthIso(weekEndDate);
  // Qualifying fits: calibrationMonthEndDate <= W's month-end.
  const qualifying = fits.filter((f) => f.calibrationMonthEndDate <= monthEnd);

  if (qualifying.length > 0) {
    // MAX calibrationMonthEndDate, tiebreak by latest fittedAt within
    // the matching calibration month.
    const sorted = [...qualifying].sort(compareFitsLatestFirst);
    return { fit: sorted[0], isExtrapolated: false };
  }

  // Fall-back: week is before any of our fits. Use the earliest calibration
  // MONTH (closest to this pre-calibration week) — but WITHIN that month pick
  // the LATEST fittedAt (the production re-fit), consistent with the qualifying
  // path above. Picking the earliest fittedAt here would select a stale/legacy
  // fit, so weeks before the calibration month would be drawn with a different
  // model than later weeks — a visible discontinuity (a worse rank showing more
  // volume across the boundary). Flag for the UI "extrapolated" tooltip.
  const sortedAsc = [...fits].sort((a, b) => {
    if (a.calibrationMonthEndDate !== b.calibrationMonthEndDate) {
      return a.calibrationMonthEndDate < b.calibrationMonthEndDate ? -1 : 1;
    }
    return a.fittedAt > b.fittedAt ? -1 : 1; // latest fittedAt wins (production fit)
  });
  return { fit: sortedAsc[0], isExtrapolated: true };
}

/** Helper: end-of-month ISO date for a given YYYY-MM-DD. */
export function endOfMonthIso(yyyyMmDd: string): string {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date format: ${yyyyMmDd}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  // Day 0 of next month = last day of this month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Sort: latest calibration_month first, then latest fitted_at as tiebreaker.
 * Used to pick the winner among qualifying fits.
 */
function compareFitsLatestFirst(a: FitParams, b: FitParams): number {
  if (a.calibrationMonthEndDate !== b.calibrationMonthEndDate) {
    return a.calibrationMonthEndDate > b.calibrationMonthEndDate ? -1 : 1;
  }
  return a.fittedAt > b.fittedAt ? -1 : 1;
}

/**
 * Anchored 4-segment piecewise grid search with iterative outlier
 * trimming. Replaces the single-segment `gridSearchBeta` for
 * production fits.
 *
 * Design (see scripts/fourSegmentFit.ts for the analysis that
 * motivated each choice):
 *   - **Breakpoints fixed at 1k / 10k / 100k**. These match the MAPE
 *     reporting bands. Auto-tuning didn't outperform fixed values in
 *     the EDA, and fixed breakpoints make the fit far more
 *     interpretable.
 *   - **Anchor in segment 1**: A1 = anchor.volume × anchor.rank^β1.
 *     Forces the curve to pass through a trusted reference point
 *     (the lowest-SFR pair in the matched dataset, where Amazon's
 *     own POE volume is most likely to be a real number).
 *   - **Continuity**: each subsequent segment's A is derived from the
 *     previous segment's A at the breakpoint:
 *       A_{n+1} = A_n × K_n^{β_{n+1} - β_n}
 *     So free params are just (β1, β2, β3, β4) — 4 numbers, grid-
 *     searched over BETA_GRID. 33^4 ≈ 1.2M combos, ~1s wall time.
 *   - **Iterative under-trim**: after each fit, drop pairs whose
 *     actual is < 1/dropRatio × predicted, then refit. Repeats until
 *     no new drops (~3-5 iterations). Only the under direction is
 *     trimmed — the over direction (POE-reported volumes vastly
 *     higher than predicted) reflects real POE broad-match behavior
 *     and removing those biases the fit toward too-low predictions.
 */
export const DEFAULT_PIECEWISE_BREAKPOINTS = [1_000, 10_000, 100_000];

export interface AnchoredPiecewiseFitResult {
  fit: PiecewiseFit;
  nKept: number;
  nDropped: number;
  iterations: number;
}

const PIECEWISE_BETA_GRID: number[] = (() => {
  const grid: number[] = [];
  for (let b = 0.2; b <= 1.6 + 1e-9; b += 0.025) grid.push(parseFloat(b.toFixed(4)));
  return grid;
})();

export function anchoredPiecewiseGridSearch(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  options: {
    anchor: { rank: number; volume: number };
    breakpoints?: number[];
    /**
     * Iterative outlier trim threshold. Pairs where actual < 1/N ×
     * predicted are dropped between iterations. Pass `Infinity` to
     * disable trimming.
     */
    trimDropRatio?: number;
  },
): AnchoredPiecewiseFitResult {
  const breakpoints = options.breakpoints ?? DEFAULT_PIECEWISE_BREAKPOINTS;
  const trimRatio = options.trimDropRatio ?? 10;
  const nSegments = breakpoints.length + 1;
  if (nSegments < 1) throw new Error('At least one segment required');

  let kept = pairs.filter((p) => p.rank > 0 && p.volume > 0);
  let fit = gridSearchSegments(kept, breakpoints, options.anchor);
  let iterations = 0;
  let nDropped = 0;
  while (iterations < 20) {
    iterations += 1;
    const next: { rank: number; volume: number }[] = [];
    let dropThisRound = 0;
    for (const p of kept) {
      const pred = predictVolumeFromFit(p.rank, fit);
      const ratio = p.volume / pred;
      if (Number.isFinite(trimRatio) && ratio < 1 / trimRatio) dropThisRound += 1;
      else next.push(p);
    }
    if (dropThisRound === 0) break;
    nDropped += dropThisRound;
    kept = next;
    fit = gridSearchSegments(kept, breakpoints, options.anchor);
  }
  return { fit, nKept: kept.length, nDropped, iterations };
}

/**
 * Inner grid search — finds the (β1, β2, ..., βN) tuple minimizing
 * log-space SSE on the given pairs. A1 is determined by the anchor;
 * subsequent A_n are derived by continuity.
 *
 * Returns a PiecewiseFit (no statistics). Used both for the initial
 * fit and for re-fits after each trim iteration.
 */
function gridSearchSegments(
  pairs: ReadonlyArray<{ rank: number; volume: number }>,
  breakpoints: number[],
  anchor: { rank: number; volume: number },
): PiecewiseFit {
  const nSegments = breakpoints.length + 1;
  // Partition pairs into segments once
  const partitioned: Array<Array<{ rank: number; volume: number }>> = Array.from(
    { length: nSegments },
    () => [],
  );
  for (const p of pairs) {
    let idx = nSegments - 1;
    for (let i = 0; i < breakpoints.length; i++) {
      if (p.rank <= breakpoints[i]) {
        idx = i;
        break;
      }
    }
    partitioned[idx].push(p);
  }

  // Recurse: for each candidate β1, compute A1 from anchor, compute
  // segment 1 SSE, then recurse to find best (β2, ..., βN). Returns
  // best tuple + its SSE.
  const best = chooseBetas(0, breakpoints, partitioned, anchor.volume * Math.pow(anchor.rank, 0), anchor);
  return {
    breakpoints,
    segments: best.betas.map((b, i) => ({ beta: b, scaleFactor: best.As[i] })),
  };
}

/**
 * Recursive grid descent. At each segment index, try every candidate
 * β, compute that segment's A from the previous-segment continuity
 * (or anchor for index 0), tally its SSE, and recurse to the next
 * segment.
 *
 * Pure function — `partitioned[i]` holds the pairs whose rank falls
 * in segment i.
 */
function chooseBetas(
  segIdx: number,
  breakpoints: number[],
  partitioned: ReadonlyArray<ReadonlyArray<{ rank: number; volume: number }>>,
  prevA: number,
  anchor: { rank: number; volume: number },
  prevBeta = 0,
): { sse: number; betas: number[]; As: number[] } {
  const nSegments = breakpoints.length + 1;
  let bestSse = Infinity;
  let bestBetas: number[] = [];
  let bestAs: number[] = [];
  for (const beta of PIECEWISE_BETA_GRID) {
    // Derive A for this segment.
    let A: number;
    if (segIdx === 0) {
      A = anchor.volume * Math.pow(anchor.rank, beta);
    } else {
      const K = breakpoints[segIdx - 1];
      A = prevA * Math.pow(K, beta - prevBeta);
    }
    // SSE for this segment's pairs.
    const logA = Math.log(A);
    let sse = 0;
    for (const p of partitioned[segIdx]) {
      const e = (logA - beta * Math.log(p.rank)) - Math.log(p.volume);
      sse += e * e;
    }
    if (segIdx === nSegments - 1) {
      if (sse < bestSse) {
        bestSse = sse;
        bestBetas = [beta];
        bestAs = [A];
      }
    } else {
      const rec = chooseBetas(segIdx + 1, breakpoints, partitioned, A, anchor, beta);
      const totalSse = sse + rec.sse;
      if (totalSse < bestSse) {
        bestSse = totalSse;
        bestBetas = [beta, ...rec.betas];
        bestAs = [A, ...rec.As];
      }
    }
  }
  return { sse: bestSse, betas: bestBetas, As: bestAs };
}

/** Subtract whole weeks from a YYYY-MM-DD date (UTC). */
export function weeksBeforeIso(yyyyMmDd: string, weeks: number): string {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date format: ${yyyyMmDd}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a SQL expression (+ bound params) mapping a rank column to
 * estimated volume for the given fit. Params are positional starting
 * at `startParamIdx`. Returns `NULL::bigint` with no params for an
 * empty fit.
 */
export function buildPiecewiseSql(
  fit: PiecewiseFit,
  rankCol: string,
  startParamIdx: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let nextIdx = startParamIdx;
  if (fit.segments.length === 0) {
    return { sql: 'NULL::bigint', params: [] };
  }
  if (fit.segments.length === 1) {
    const s = fit.segments[0];
    params.push(s.beta.toFixed(6), s.scaleFactor.toFixed(6));
    const bIdx = nextIdx++;
    const aIdx = nextIdx++;
    return {
      sql: `($${aIdx}::numeric * power(${rankCol}::numeric, -$${bIdx}::numeric))::bigint`,
      params,
    };
  }
  const whenClauses: string[] = [];
  for (let i = 0; i < fit.segments.length - 1; i++) {
    const seg = fit.segments[i];
    const bp = fit.breakpoints[i];
    params.push(bp, seg.beta.toFixed(6), seg.scaleFactor.toFixed(6));
    const bpIdx = nextIdx++;
    const bIdx = nextIdx++;
    const aIdx = nextIdx++;
    whenClauses.push(
      `WHEN ${rankCol} <= $${bpIdx}::int THEN ($${aIdx}::numeric * power(${rankCol}::numeric, -$${bIdx}::numeric))::bigint`,
    );
  }
  const last = fit.segments[fit.segments.length - 1];
  params.push(last.beta.toFixed(6), last.scaleFactor.toFixed(6));
  const lastBIdx = nextIdx++;
  const lastAIdx = nextIdx++;
  const elseClause = `ELSE ($${lastAIdx}::numeric * power(${rankCol}::numeric, -$${lastBIdx}::numeric))::bigint`;
  return { sql: `CASE ${whenClauses.join(' ')} ${elseClause} END`, params };
}

/**
 * Build the current-week + lookback volume SQL expressions for the kcs
 * refresh. For each horizon, pick the fit for that horizon's week
 * (weeks=0 means the current week) and emit the piecewise SQL applied
 * to that horizon's rank column. Positional params chain across all
 * horizons starting at `startParamIdx`. Pure — unit tested.
 */
export function buildVolumeExpressions(
  currentWeekEndDate: string,
  fits: ReadonlyArray<FitParams>,
  horizons: ReadonlyArray<{ weeks: number; rankCol: string }>,
  startParamIdx: number,
): { exprs: string[]; params: unknown[] } {
  const exprs: string[] = [];
  const params: unknown[] = [];
  let idx = startParamIdx;
  for (const h of horizons) {
    const week = h.weeks === 0 ? currentWeekEndDate : weeksBeforeIso(currentWeekEndDate, h.weeks);
    const sel = pickFitForWeek(week, fits);
    if (!sel) {
      exprs.push('NULL::bigint');
      continue;
    }
    const pw = buildPiecewiseSql(sel.fit, h.rankCol, idx);
    exprs.push(pw.sql);
    params.push(...pw.params);
    idx += pw.params.length;
  }
  return { exprs, params };
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
