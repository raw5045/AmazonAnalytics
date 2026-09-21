/**
 * Volume monotonicity guard (arc 1, Task 20).
 *
 * The MCP research volume sort (lib/research/query.ts `orderByFor`,
 * `estimatedMonthlySearches` desc) is compiled as `current_rank ASC` rather
 * than an ORDER BY on the volume column itself — cheaper, and correct only
 * because the stored estimate is guaranteed non-increasing in rank by
 * construction (buildPiecewiseSql in lib/analytics/volumeModel.ts fits one
 * monotone curve per snapshot). If that guarantee is ever violated — a bad
 * calibration fit, a future multi-fit change, a data bug — rank order and
 * volume order silently diverge and the research tool returns wrong results
 * without erroring.
 *
 * An "inversion" is a rank-ordered row whose estimated_monthly_volume_current
 * is HIGHER than the row immediately before it (lower rank number = better
 * rank = should have >= volume). Zero inversions is the invariant; any
 * inversion count above zero means the guarantee above no longer holds.
 *
 * This module is called from inngest/functions/refreshSummary.ts against the
 * `kcs` STAGE table, BEFORE the stage/live swap — so a violation shows up in
 * the refresh log the same week it appears, not after it's already live and
 * silently corrupting the research sort. The check is fail-soft (logged, never
 * thrown) — see the call site for why a violation must not abort the refresh.
 */

export type KcsTable = 'keyword_current_summary' | 'keyword_current_summary_stage';

/**
 * SQL counting rank-ordered rows whose estimate rises above the previous
 * row's — should be zero within a snapshot. `table` is a closed union, never
 * user input, so interpolating it directly is safe (no injection surface).
 */
export function volumeInversionsSql(table: KcsTable): string {
  return `
    SELECT count(*)::int AS inversions
    FROM (
      SELECT estimated_monthly_volume_current AS v,
             lag(estimated_monthly_volume_current) OVER (ORDER BY current_rank, search_term_id) AS prev
      FROM ${table}
      WHERE estimated_monthly_volume_current IS NOT NULL
    ) s
    WHERE prev IS NOT NULL AND v > prev`;
}

/**
 * Runs volumeInversionsSql and returns the inversion count (0 when the result is empty).
 * `inversions` is typed `number | string` because the SQL casts it `::int`, but a bare
 * count() aggregate — and some pg driver configurations — surface bigint-derived values
 * as strings; Number(...) normalizes either.
 */
export async function countVolumeInversions(
  client: { query: (sql: string) => Promise<{ rows: Array<{ inversions: number | string }> }> },
  table: KcsTable,
): Promise<number> {
  const r = await client.query(volumeInversionsSql(table));
  return Number(r.rows[0]?.inversions ?? 0);
}
