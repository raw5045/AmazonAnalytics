/**
 * Orchestrates the rank-to-volume model fit: fetches calibration pairs
 * for a month, splits 70/30 by volume decile, runs the anchored
 * piecewise grid search with iterative outlier trimming, validates
 * MAPE by rank band on holdout, persists the result to
 * model_calibration_runs.
 *
 * Used by:
 *   - scripts/fitVolumeModel.ts (CLI path, manual fit)
 *   - worker/calibrationJobs.ts (in-app upload path, fits automatically
 *     after a combined BA + POE upload)
 *
 * Model: 4-segment piecewise power law with breakpoints at 1k/10k/100k,
 * anchored to the lowest-SFR pair (where Amazon's POE volume is most
 * trustworthy), with iterative 10× under-trim to drop pairs where POE
 * clearly under-reports relative to the SFR rank.
 *
 * Category exclusion: keywords whose latest-week top-clicked category
 * is in EXCLUDED_CATEGORIES are filtered out before fitting. Currently:
 * Fresh_Produce and Fresh_Perishable, which fit terribly because
 * Amazon Fresh's browse-driven impressions inflate BA SFR rank while
 * POE captures only literal typed searches — a fundamental metric
 * mismatch we can't fix in the math layer. See category-level error
 * analysis from 2026-05-21 conversation.
 *
 * Returns the persisted run id + the full result for reporting (email,
 * console summary, UI surfacing).
 */
import { Pool } from 'pg';
import {
  anchoredPiecewiseGridSearch,
  DEFAULT_PIECEWISE_BREAKPOINTS,
  predictVolumeFromFit,
  type PiecewiseFit,
} from '@/lib/analytics/volumeModel';
import type { FitParamsJson } from '@/db/schema/modelCalibrationRuns';

interface Pair {
  rank: number;
  volume: number;
}

/**
 * Categories whose (rank, volume) pairs are excluded from the fit.
 * See the file header for rationale. Match is case-sensitive against
 * `keyword_weekly_metrics.top_clicked_category_1`.
 *
 * Predictions for keywords IN these categories still get computed by
 * the model at refresh / detail-page time — they're just not used to
 * TRAIN the model. Treat any such prediction as low-confidence.
 */
export const EXCLUDED_CATEGORIES_FROM_FIT: readonly string[] = [
  'Fresh_Produce',
  'Fresh_Perishable',
];

export interface FitOrchestrationResult {
  runId: string;
  calibrationMonthEndDate: string;
  /** Head-segment β (for legacy callers and console display). */
  beta: number;
  /** Head-segment A. */
  scaleFactor: number;
  /** Full piecewise fit. */
  fitParams: FitParamsJson;
  /** Pairs available before category exclusion. */
  nPairsBeforeFilter: number;
  /** Pairs available AFTER category exclusion (becomes train + holdout). */
  nPairs: number;
  /** Count of pairs dropped by category filter (Fresh_Produce, etc.). */
  nExcludedByCategory: number;
  nTraining: number;
  nHoldout: number;
  nDroppedAsOutliers: number;
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
    const { pairs, nBeforeFilter } = await fetchPairs(pool, args.monthEndDate);
    if (pairs.length < 20) {
      throw new FitInsufficientDataError(pairs.length);
    }
    const nExcludedByCategory = nBeforeFilter - pairs.length;

    const { train, holdout } = stratifiedSplit(pairs);

    // Anchor on the lowest-SFR pair in the matched set — that's
    // where Amazon's POE volume is most likely to be a real number
    // (head terms; less aggressive POE rounding/banding). Using the
    // FULL pair set (not just train) for the anchor selection so the
    // anchor doesn't shift based on the train/holdout split.
    const anchorPair = pairs.reduce((best, p) => (p.rank < best.rank ? p : best), pairs[0]);
    const anchor = { rank: anchorPair.rank, volume: anchorPair.volume };

    const result = anchoredPiecewiseGridSearch(train, {
      anchor,
      breakpoints: DEFAULT_PIECEWISE_BREAKPOINTS,
      trimDropRatio: 10,
    });
    const fit = result.fit;

    const stratified = stratifiedMapeFromFit(holdout, fit);

    const fitParams: FitParamsJson = {
      kind: fit.segments.length === 1 ? 'single' : 'piecewise',
      anchor,
      breakpoints: fit.breakpoints,
      segments: fit.segments,
      trimDropRatio: 10,
      nDropped: result.nDropped,
    };

    const runId = await recordRun(pool, {
      calibrationMonthEndDate: args.monthEndDate,
      // Legacy columns: head segment
      beta: fit.segments[0].beta,
      scaleFactor: fit.segments[0].scaleFactor,
      fitParams,
      nTraining: train.length,
      nHoldout: holdout.length,
      mapeOverall: stratified.overall,
      mapeTop1k: stratified.top1k,
      mape1k10k: stratified.rank1kTo10k,
      mape10k100k: stratified.rank10kTo100k,
      mapeAbove100k: stratified.above100k,
      notes: args.notes ?? null,
    });

    return {
      runId,
      calibrationMonthEndDate: args.monthEndDate,
      beta: fit.segments[0].beta,
      scaleFactor: fit.segments[0].scaleFactor,
      fitParams,
      nPairsBeforeFilter: nBeforeFilter,
      nPairs: pairs.length,
      nExcludedByCategory,
      nTraining: train.length,
      nHoldout: holdout.length,
      nDroppedAsOutliers: result.nDropped,
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

/**
 * Per-band MAPE on holdout, using a piecewise fit. Equivalent to the
 * single-segment `stratifiedMape` helper but accepts the new fit
 * structure. Returns the same shape so the orchestrator + email
 * builder don't need to know which type of fit they're reporting.
 */
function stratifiedMapeFromFit(
  pairs: ReadonlyArray<Pair>,
  fit: PiecewiseFit,
): {
  overall: number | null;
  top1k: number | null;
  rank1kTo10k: number | null;
  rank10kTo100k: number | null;
  above100k: number | null;
} {
  const bands = {
    top1k: [] as Pair[],
    rank1kTo10k: [] as Pair[],
    rank10kTo100k: [] as Pair[],
    above100k: [] as Pair[],
  };
  for (const p of pairs) {
    if (p.rank <= 0 || p.volume <= 0) continue;
    if (p.rank <= 1_000) bands.top1k.push(p);
    else if (p.rank <= 10_000) bands.rank1kTo10k.push(p);
    else if (p.rank <= 100_000) bands.rank10kTo100k.push(p);
    else bands.above100k.push(p);
  }
  const mape = (set: Pair[]) => {
    if (set.length === 0) return null;
    let sum = 0;
    for (const p of set) {
      const pred = predictVolumeFromFit(p.rank, fit);
      sum += Math.abs(pred - p.volume) / p.volume;
    }
    return sum / set.length;
  };
  return {
    overall: mape(pairs.filter((p) => p.rank > 0 && p.volume > 0)),
    top1k: mape(bands.top1k),
    rank1kTo10k: mape(bands.rank1kTo10k),
    rank10kTo100k: mape(bands.rank10kTo100k),
    above100k: mape(bands.above100k),
  };
}

/**
 * Returns matched (BA, POE) pairs for the month, with category-
 * excluded pairs filtered out. Also reports `nBeforeFilter` for
 * diagnostics so the orchestrator can record how many were dropped.
 *
 * Category source: the most recent `top_clicked_category_1` from
 * `keyword_weekly_metrics` for each term. NULL (no kwm row recently)
 * is treated as "unknown" and NOT excluded — we'd rather train on
 * unknown-category pairs than throw them away.
 */
async function fetchPairs(pool: Pool, monthEndDate: string): Promise<{ pairs: Pair[]; nBeforeFilter: number }> {
  const c = await pool.connect();
  try {
    // First the total available, then the filtered set in one query so
    // we can report both counts. LEFT JOIN LATERAL pulls the latest-week
    // category from kwm; the WHERE NOT IN clause drops excluded pairs.
    const excludedList = EXCLUDED_CATEGORIES_FROM_FIT.map((_, i) => `$${i + 2}`).join(', ');
    const queryParams: (string | string[])[] = [monthEndDate, ...EXCLUDED_CATEGORIES_FROM_FIT];
    const { rows } = await c.query<{
      actual_rank: number;
      poe_30_day_volume: string;
      category: string | null;
      is_excluded: boolean;
    }>(
      `
      SELECT
        m.actual_rank,
        p.poe_30_day_volume::text AS poe_30_day_volume,
        cat.top_clicked_category_1 AS category,
        (cat.top_clicked_category_1 IS NOT NULL
          AND cat.top_clicked_category_1 IN (${excludedList})) AS is_excluded
      FROM monthly_sfr m
      JOIN poe_calibration_data p
        ON p.search_term_normalized = m.search_term_normalized
       AND p.month_end_date = m.month_end_date
      JOIN search_terms st
        ON st.search_term_normalized = m.search_term_normalized
      LEFT JOIN LATERAL (
        SELECT top_clicked_category_1
        FROM keyword_weekly_metrics
        WHERE search_term_id = st.id
        ORDER BY week_end_date DESC
        LIMIT 1
      ) cat ON true
      WHERE m.month_end_date = $1::date
        AND m.actual_rank > 0
        AND p.poe_30_day_volume > 0
      `,
      queryParams,
    );
    const nBeforeFilter = rows.length;
    const pairs: Pair[] = rows
      .filter((r) => !r.is_excluded)
      .map((r) => ({ rank: r.actual_rank, volume: Number(r.poe_30_day_volume) }));
    return { pairs, nBeforeFilter };
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
    fitParams: FitParamsJson;
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
        calibration_month_end_date, beta, scale_factor, fit_params,
        n_training_keywords, n_holdout_keywords,
        mape_overall, mape_top_1k, mape_1k_10k, mape_10k_100k, mape_above_100k,
        notes
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
      `,
      [
        args.calibrationMonthEndDate,
        args.beta.toFixed(4),
        args.scaleFactor.toFixed(6),
        JSON.stringify(args.fitParams),
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
