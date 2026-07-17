/**
 * Orchestrates the rank-to-volume model fit: fetches calibration pairs
 * for a month, splits 70/30 by volume decile, runs the anchored
 * piecewise grid search with iterative outlier trimming, validates
 * MAPE by rank band on holdout, and — only when `persist` is set —
 * writes the result to model_calibration_runs.
 *
 * Used by:
 *   - scripts/fitVolumeModel.ts (CLI path, manual fit)
 *   - worker/calibrationJobs.ts (in-app upload path, dry-run fit
 *     automatically after an upload that includes an SQP file)
 *
 * Model: 4-segment piecewise power law with breakpoints at 1k/10k/100k,
 * trained on SQP ⋈ monthly_sfr pairs (the owner's first-party Search
 * Query Performance export — Amazon's own marketplace-wide query
 * counts), anchored to the lowest-SFR SQP pair. POE is demoted to
 * validation-only, with one exception: POE pairs at ranks strictly
 * better than the month's best SQP rank are admitted as supplemental
 * head training pairs — the two sources measured within 4% of each
 * other in the ≤100 band, and SQP is structurally blind above its own
 * best rank (spec 2026-07-16, head-extrapolation amendment). Iterative
 * under-trim (default 10×, see `trimDropRatio`) drops pairs whose
 * reported volume clearly under-reports relative to the SFR rank.
 *
 * Category exclusion: keywords whose latest-week top-clicked category
 * is in EXCLUDED_CATEGORIES are filtered out before fitting — applied
 * to ALL training pairs from both sources. Currently: Fresh_Produce
 * and Fresh_Perishable, which fit terribly because Amazon Fresh's
 * browse-driven impressions inflate BA SFR rank while the volume
 * sources (SQP and POE alike) count only literal typed searches — a
 * fundamental metric mismatch we can't fix in the math layer. See
 * category-level error analysis from 2026-05-21 conversation.
 *
 * Dry-run vs persist: the default run computes the fit plus the full
 * validation report (holdout MAPE, POE cross-check, level delta vs
 * production, implied rank-1 volume) and writes NOTHING. Passing
 * `persist: true` records the run — the owner-gated go-live step:
 * detail pages read persisted fits immediately, kcs picks them up at
 * the next weekly refresh.
 *
 * Returns the run id (null on dry-run) + the full result for reporting
 * (email, console summary, UI surfacing).
 */
import { Pool } from 'pg';
import {
  anchoredPiecewiseGridSearch,
  DEFAULT_PIECEWISE_BREAKPOINTS,
  predictVolumeFromFit,
  type PiecewiseFit,
} from '@/lib/analytics/volumeModel';
import type { FitParamsJson } from '@/db/schema/modelCalibrationRuns';

/**
 * Minimal (rank, volume) shape. The fit math and MAPE helpers only
 * read these two fields — they don't care which source a pair came
 * from.
 */
interface RankVolume {
  rank: number;
  volume: number;
}

/** A training pair, tagged with the calibration source that produced it. */
interface Pair extends RankVolume {
  source: 'sqp' | 'poe_head';
}

/**
 * Categories whose (rank, volume) pairs are excluded from the fit —
 * applied to ALL training pairs from both sources. See the file header
 * for rationale. Match is case-sensitive against
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
  /** Persisted run id, or null on a dry-run (nothing written). */
  runId: string | null;
  /** Whether this run wrote model_calibration_runs (go-live) or was a dry-run. */
  persisted: boolean;
  calibrationMonthEndDate: string;
  /** Head-segment β (for legacy callers and console display). */
  beta: number;
  /** Head-segment A. */
  scaleFactor: number;
  /** Full piecewise fit. */
  fitParams: FitParamsJson;
  /** Pairs available before category exclusion (SQP + admitted POE head). */
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
  /** MAPE bands of the new fit against the month's POE pairs (validation only; expected worse than holdout — different source units). Null when no POE data for the month. */
  poeValidation: { overall: number | null; top1k: number | null; rank1kTo10k: number | null; rank10kTo100k: number | null; above100k: number | null } | null;
  /** Median predicted-volume ratio (new fit ÷ current production fit) at fixed probe ranks per band. Null when no production fit exists. */
  levelDeltaVsProduction: { top1k: number; rank1kTo10k: number; rank10kTo100k: number; above100k: number } | null;
  /** predictVolumeFromFit(1, fit) — the owner's monthly gut-check for the extrapolated top of the curve. */
  impliedRank1Volume: number;
  /** How many POE head-supplement pairs were admitted (spec amendment). */
  nPoeHeadPairs: number;
  /** The anchor pair used (always an SQP pair). */
  anchor: { rank: number; volume: number };
  durationMs: number;
}

/**
 * Thrown when the post-filter SQP pair count is < 20. POE
 * head-supplement pairs can't satisfy the minimum — the fit's level is
 * pinned to SQP, so without enough SQP pairs there's nothing to train.
 */
export class FitInsufficientDataError extends Error {
  constructor(public readonly nPairs: number) {
    super(`Insufficient SQP calibration pairs: ${nPairs} (need ≥ 20 for a meaningful fit)`);
    this.name = 'FitInsufficientDataError';
  }
}

/**
 * Run the full fit pipeline for a given month. Dry-run by default:
 * computes the fit + the full validation report and writes NOTHING.
 * Pass `persist: true` to record the run to model_calibration_runs —
 * the go-live step (detail pages read persisted fits immediately; kcs
 * at the next weekly refresh). Caller provides a pool (shared
 * connection lifecycle) or omits to let us manage our own.
 */
export async function runFitOrchestration(args: {
  monthEndDate: string;
  notes?: string | null;
  pool?: Pool;
  /** Write the run to model_calibration_runs (go-live). Default false = dry-run. */
  persist?: boolean;
  /**
   * Iterative under-trim threshold for the grid search, recorded in
   * fit_params. Default 10 (tuned on POE under-reporting; the first
   * SQP fit's drop count tells us whether it still earns its keep).
   */
  trimDropRatio?: number;
}): Promise<FitOrchestrationResult> {
  const startedAt = Date.now();
  const persist = args.persist ?? false;
  const trimDropRatio = args.trimDropRatio ?? 10;
  const ownPool = !args.pool;
  const pool =
    args.pool ??
    new Pool({
      connectionString: process.env.DATABASE_URL!,
      statement_timeout: 600_000,
    });

  try {
    const { pairs, nBeforeFilter } = await fetchPairs(pool, args.monthEndDate);
    const sqpPairs = pairs.filter((p) => p.source === 'sqp');
    if (sqpPairs.length < 20) {
      throw new FitInsufficientDataError(sqpPairs.length);
    }
    const nExcludedByCategory = nBeforeFilter - pairs.length;
    const nPoeHeadPairs = pairs.length - sqpPairs.length;

    const { train, holdout } = stratifiedSplit(pairs);

    // Anchor on the lowest-SFR SQP pair — never a POE pair. The curve's
    // level is pinned to first-party SQP data; the admitted POE head
    // pairs (ranks above the anchor) only inform the slope there (spec
    // amendment 2026-07-16). Selected from the FULL SQP set (not just
    // train) so the anchor doesn't shift based on the train/holdout
    // split.
    const anchorPair = sqpPairs.reduce((best, p) => (p.rank < best.rank ? p : best), sqpPairs[0]);
    const anchor = { rank: anchorPair.rank, volume: anchorPair.volume };

    const result = anchoredPiecewiseGridSearch(train, {
      anchor,
      breakpoints: DEFAULT_PIECEWISE_BREAKPOINTS,
      trimDropRatio,
    });
    const fit = result.fit;

    const stratified = stratifiedMapeFromFit(holdout, fit);

    // Secondary validation: the new fit scored against the month's POE
    // pairs (POE no longer trains — spec 2026-07-16). Expect worse
    // numbers than holdout — different source units; the signal is
    // drift over months, not absolute level.
    const poePairs = await fetchPoeValidationPairs(pool, args.monthEndDate);
    const poeValidation = poePairs.length === 0 ? null : stratifiedMapeFromFit(poePairs, fit);

    // Level delta vs the CURRENT production fit — fetched before any
    // persist below so a persisted run never compares against itself.
    const productionFit = await fetchLatestProductionFit(pool);
    const levelDeltaVsProduction =
      productionFit === null ? null : probeLevelDelta(fit, productionFit);

    const impliedRank1Volume = predictVolumeFromFit(1, fit);

    const fitParams: FitParamsJson = {
      kind: fit.segments.length === 1 ? 'single' : 'piecewise',
      anchor,
      breakpoints: fit.breakpoints,
      segments: fit.segments,
      trimDropRatio,
      nDropped: result.nDropped,
    };

    let runId: string | null = null;
    if (persist) {
      runId = await recordRun(pool, {
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
    }

    return {
      runId,
      persisted: persist,
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
      poeValidation,
      levelDeltaVsProduction,
      impliedRank1Volume,
      nPoeHeadPairs,
      anchor,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (ownPool) await pool.end();
  }
}

/**
 * Per-band MAPE of a piecewise fit over a pair set — the holdout, or
 * the POE validation pairs. Equivalent to the single-segment
 * `stratifiedMape` helper but accepts the new fit structure. Returns
 * the same shape so the orchestrator + email builder don't need to
 * know which type of fit they're reporting.
 */
function stratifiedMapeFromFit(
  pairs: ReadonlyArray<RankVolume>,
  fit: PiecewiseFit,
): {
  overall: number | null;
  top1k: number | null;
  rank1kTo10k: number | null;
  rank10kTo100k: number | null;
  above100k: number | null;
} {
  const bands = {
    top1k: [] as RankVolume[],
    rank1kTo10k: [] as RankVolume[],
    rank10kTo100k: [] as RankVolume[],
    above100k: [] as RankVolume[],
  };
  for (const p of pairs) {
    if (p.rank <= 0 || p.volume <= 0) continue;
    if (p.rank <= 1_000) bands.top1k.push(p);
    else if (p.rank <= 10_000) bands.rank1kTo10k.push(p);
    else if (p.rank <= 100_000) bands.rank10kTo100k.push(p);
    else bands.above100k.push(p);
  }
  const mape = (set: RankVolume[]) => {
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

/** Probe ranks per band for the level-delta report (geometric mid-points). */
export const LEVEL_DELTA_PROBES = {
  top1k: [50, 300],
  rank1kTo10k: [3_000],
  rank10kTo100k: [30_000],
  above100k: [300_000],
} as const;

/** Median new÷production predicted-volume ratio per band at fixed probe ranks. Pure. */
export function probeLevelDelta(
  newFit: PiecewiseFit,
  prodFit: PiecewiseFit,
): { top1k: number; rank1kTo10k: number; rank10kTo100k: number; above100k: number } {
  const bandMedian = (probes: readonly number[]): number => {
    const ratios = probes
      .map((rank) => predictVolumeFromFit(rank, newFit) / predictVolumeFromFit(rank, prodFit))
      .sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    return ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  };
  return {
    top1k: bandMedian(LEVEL_DELTA_PROBES.top1k),
    rank1kTo10k: bandMedian(LEVEL_DELTA_PROBES.rank1kTo10k),
    rank10kTo100k: bandMedian(LEVEL_DELTA_PROBES.rank10kTo100k),
    above100k: bandMedian(LEVEL_DELTA_PROBES.above100k),
  };
}

/**
 * Returns the month's training pairs, tagged by source, with category-
 * excluded pairs filtered out. Also reports `nBeforeFilter` for
 * diagnostics so the orchestrator can record how many were dropped.
 *
 * Sources (spec 2026-07-16):
 *   - 'sqp': SQP ⋈ monthly_sfr on (term, month) — the primary training
 *     set, first-party volume.
 *   - 'poe_head': POE ⋈ monthly_sfr pairs whose rank is STRICTLY lower
 *     (better) than the month's best SQP rank. Head supplement per the
 *     head-extrapolation amendment: the ≤100 band is where POE and SQP
 *     measured within 4% of each other, and SQP is structurally blind
 *     there (the owner's brand terms never include Amazon's overall
 *     top ranks), so these pairs inform the slope above the SQP anchor.
 *
 * Category source: the most recent `top_clicked_category_1` from
 * `keyword_weekly_metrics` for each term. NULL (no kwm row recently)
 * is treated as "unknown" and NOT excluded — we'd rather train on
 * unknown-category pairs than throw them away.
 */
async function fetchPairs(pool: Pool, monthEndDate: string): Promise<{ pairs: Pair[]; nBeforeFilter: number }> {
  const c = await pool.connect();
  try {
    // Both sources + category flag in one query so we can report both
    // counts. LEFT JOIN LATERAL pulls the latest-week category from
    // kwm; `is_excluded` is computed in SQL and filtered below.
    const excludedList = EXCLUDED_CATEGORIES_FROM_FIT.map((_, i) => `$${i + 2}`).join(', ');
    const queryParams: (string | string[])[] = [monthEndDate, ...EXCLUDED_CATEGORIES_FROM_FIT];
    const { rows } = await c.query<{
      actual_rank: number;
      volume: string;
      source: 'sqp' | 'poe_head';
      category: string | null;
      is_excluded: boolean;
    }>(
      `
      WITH sqp_pairs AS (
        SELECT m.actual_rank, s.sqp_monthly_volume::text AS volume,
               m.search_term_normalized, 'sqp'::text AS source
        FROM monthly_sfr m
        JOIN sqp_calibration_data s
          ON s.search_term_normalized = m.search_term_normalized
         AND s.month_end_date = m.month_end_date
        WHERE m.month_end_date = $1::date AND m.actual_rank > 0 AND s.sqp_monthly_volume > 0
      ), sqp_best AS (
        SELECT COALESCE(MIN(actual_rank), 0) AS best_rank FROM sqp_pairs
      ),
      -- Head supplement (spec 2026-07-16, head-extrapolation amendment):
      -- POE pairs at ranks strictly better than the month's best SQP
      -- rank are admitted as training pairs — POE and SQP measured
      -- within 4% in the ≤100 band, and SQP never covers Amazon's
      -- overall top ranks. Everywhere else POE is validation-only.
      poe_head AS (
        SELECT m.actual_rank, p.poe_30_day_volume::text AS volume,
               m.search_term_normalized, 'poe_head'::text AS source
        FROM monthly_sfr m
        JOIN poe_calibration_data p
          ON p.search_term_normalized = m.search_term_normalized
         AND p.month_end_date = m.month_end_date
        WHERE m.month_end_date = $1::date AND m.actual_rank > 0 AND p.poe_30_day_volume > 0
          AND m.actual_rank < (SELECT best_rank FROM sqp_best)
      ), all_pairs AS (
        SELECT * FROM sqp_pairs UNION ALL SELECT * FROM poe_head
      )
      SELECT a.actual_rank, a.volume, a.source,
             cat.top_clicked_category_1 AS category,
             (cat.top_clicked_category_1 IS NOT NULL
               AND cat.top_clicked_category_1 IN (${excludedList})) AS is_excluded
      FROM all_pairs a
      JOIN search_terms st ON st.search_term_normalized = a.search_term_normalized
      LEFT JOIN LATERAL (
        SELECT top_clicked_category_1
        FROM keyword_weekly_metrics
        WHERE search_term_id = st.id
        ORDER BY week_end_date DESC
        LIMIT 1
      ) cat ON true
      `,
      queryParams,
    );
    const nBeforeFilter = rows.length;
    const pairs: Pair[] = rows
      .filter((r) => !r.is_excluded)
      .map((r) => ({ rank: r.actual_rank, volume: Number(r.volume), source: r.source }));
    return { pairs, nBeforeFilter };
  } finally {
    c.release();
  }
}

/**
 * Returns matched (BA, POE) pairs for the month — the pre-SQP training
 * query, preserved verbatim as the validation set (POE no longer
 * trains; spec 2026-07-16). Same lateral-category exclusion as
 * fetchPairs so validation scores aren't polluted by the categories we
 * refuse to train on.
 */
async function fetchPoeValidationPairs(pool: Pool, monthEndDate: string): Promise<RankVolume[]> {
  const c = await pool.connect();
  try {
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
    return rows
      .filter((r) => !r.is_excluded)
      .map((r) => ({ rank: r.actual_rank, volume: Number(r.poe_30_day_volume) }));
  } finally {
    c.release();
  }
}

/**
 * Latest persisted fit (by fitted_at) reconstructed as a PiecewiseFit.
 * Same reconstruction rule as fetchKeywordDetail: fit_params when
 * present, else the legacy (beta, scale_factor) columns as a single
 * segment. Null when no calibration run exists yet.
 */
async function fetchLatestProductionFit(pool: Pool): Promise<PiecewiseFit | null> {
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{
      beta: string;
      scale_factor: string;
      fit_params: FitParamsJson | null;
    }>(
      `
      SELECT beta::text AS beta, scale_factor::text AS scale_factor, fit_params
      FROM model_calibration_runs
      ORDER BY fitted_at DESC
      LIMIT 1
      `,
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const segments = r.fit_params?.segments ?? [
      { beta: parseFloat(r.beta), scaleFactor: parseFloat(r.scale_factor) },
    ];
    const breakpoints = r.fit_params?.breakpoints ?? [];
    return { breakpoints, segments };
  } finally {
    c.release();
  }
}

/**
 * Stratified train/test split by volume decile. Each decile contributes
 * its first ~70% (deterministic — sorted by volume within decile) to
 * train and the remaining ~30% to test. Preserves the volume
 * distribution in both halves. Source tags ride along untouched — the
 * split doesn't care where a pair came from.
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
