import type { Pool } from 'pg';
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';
import { withReadOnlyTx } from '@/lib/db/tcpPool';
import type { FitParams } from '@/lib/analytics/volumeModel';
import { seriesToHistoryRows } from '@/lib/explorer/chartSeries';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import type { HistoryPoint, KeywordHistoryResponse, Severity, Warning } from './contracts';
import { ResearchError, dataUnavailableError, keywordNotFoundError, queryTimeoutError } from './errors';
import { isoUtcSql, loadSnapshotMeta } from './snapshot';

/** 'YYYY-MM-DD' shifted by whole days in UTC. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Parent §11.5: the calendar window ending at the dataset week; absent weeks are missing
 * observations, never zeros. `weeks` is 1..52 (the same range `loadKeywordHistory` defends
 * with its own guard, ultimately bounded by `keywordHistoryInputSchema` at the API boundary);
 * this pure function trusts its caller and does not re-check it.
 */
export function computeHistoryWindow(rows: KeywordDetailHistoryRow[], datasetWeek: string, weeks: number) {
  const windowStart = addDays(datasetWeek, -(weeks - 1) * 7);
  const inWindow = rows
    .filter((r) => r.weekEndDate >= windowStart && r.weekEndDate <= datasetWeek)
    // Plain code-unit order, not localeCompare (see categories.ts's module docstring for why):
    // these are ISO 'YYYY-MM-DD' strings, and the research modules standardize on code-unit
    // ordering everywhere for a pure, host-independent sort.
    .sort((a, b) => (a.weekEndDate < b.weekEndDate ? -1 : a.weekEndDate > b.weekEndDate ? 1 : 0));
  const present = new Set(inWindow.map((r) => r.weekEndDate));
  const missingWeeks: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const w = addDays(windowStart, i * 7);
    if (!present.has(w)) missingWeeks.push(w);
  }
  const points: HistoryPoint[] = inWindow.map((r) => ({
    weekEndDate: r.weekEndDate,
    rank: r.actualRank,
    estimatedMonthlySearches: r.estimatedMonthlyVolume,
    volumeIsExtrapolated: r.estimatedMonthlyVolumeIsExtrapolated,
    severity: (r.fakeVolumeSeverity as Severity | null) ?? null,
  }));
  return { windowStart, windowEnd: datasetWeek, points, missingWeeks };
}

/**
 * Deps for `loadKeywordHistory`: a node-postgres `Pool` (research runs its own dedicated pool,
 * separate from the Explorer's — see lib/db/tcpPool.ts's module docstring), the transaction's
 * statement-timeout budget in ms, and a fit loader so the caller controls how calibration fits
 * are sourced (the default wiring reads `model_calibration_runs` via `fetchFits` in
 * lib/explorer/fetchKeywordDetail.ts; tests inject a stub).
 */
export interface HistoryDeps { pool: Pool; timeoutMs: number; fetchFits: () => Promise<FitParams[]> }

/**
 * `get_keyword_history`: the cached `keyword_chart_series` row for `searchTermId`, windowed to
 * the calendar range ending at the current dataset week (parent §11.5). Meta, the keyword's
 * raw text, and the series all come from ONE read-only transaction so they describe the same
 * snapshot. `weeks` must be an integer in 1..52 — `keywordHistoryInputSchema` is the
 * caller-facing gate at the API boundary, but this is a defensive, fail-fast check against a
 * programming error in a caller that bypasses that schema (a plain `Error`, not a
 * `ResearchError`: this is not a request-validation failure a client should ever see well-formed).
 *
 * Throws `DATA_UNAVAILABLE` when the snapshot meta row is missing (the kill switch),
 * `KEYWORD_NOT_FOUND` for an unknown `searchTermId`, `QUERY_TIMEOUT` when the transaction's
 * statement budget is exceeded, and `HISTORY_UNAVAILABLE` when no cached series exists yet (no
 * row, or a row whose `series` array is empty) — `get_keyword_details` still works in that case.
 */
export async function loadKeywordHistory(searchTermId: string, weeks: number, deps: HistoryDeps): Promise<KeywordHistoryResponse> {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
    throw new Error(`loadKeywordHistory: weeks must be an integer 1..52, got ${weeks}`);
  }
  const out = await withReadOnlyTx(deps.pool, deps.timeoutMs, async (client) => {
    const meta = await loadSnapshotMeta(client);
    if (!meta) throw dataUnavailableError();
    const term = (await client.query('SELECT search_term_raw FROM search_terms WHERE id = $1', [searchTermId])).rows[0] as { search_term_raw: string } | undefined;
    if (!term) throw keywordNotFoundError();
    const series = (await client.query(
      `SELECT series, ${isoUtcSql('updated_at')} AS updated_at
       FROM keyword_chart_series WHERE search_term_id = $1`,
      [searchTermId],
    )).rows[0] as { series: ChartSeriesEntry[]; updated_at: string } | undefined;
    return { meta, keyword: term.search_term_raw, series: series ?? null };
  });
  if (out === 'timeout') throw queryTimeoutError(deps.timeoutMs);
  if (!out.series || !Array.isArray(out.series.series) || out.series.series.length === 0) {
    throw new ResearchError('HISTORY_UNAVAILABLE', 'No cached weekly history exists for this keyword yet; get_keyword_details still works.');
  }
  const fits = await deps.fetchFits();
  const window = computeHistoryWindow(seriesToHistoryRows(out.series.series, fits), out.meta.currentWeekEndDate, weeks);
  const warnings: Warning[] = [{ code: 'ESTIMATED_VOLUME', message: 'estimatedMonthlySearches values are estimates derived from rank and calibration.' }];
  const lastWeek = out.series.series[out.series.series.length - 1]?.w ?? null;
  if (lastWeek && lastWeek < out.meta.currentWeekEndDate) {
    warnings.push({ code: 'SERIES_BEHIND_DATASET', message: `The cached series ends at ${lastWeek}, before the dataset week ${out.meta.currentWeekEndDate}.` });
  }
  if (window.missingWeeks.length > 0) {
    warnings.push({ code: 'MISSING_WEEKS', message: `${window.missingWeeks.length} of ${weeks} weeks have no observation; a missing week is not zero demand.` });
  }
  // out.series.updated_at is already ISO (to_char above) — passed through unchanged, same
  // no-JS-date-parsing convention as snapshot.ts's mapMeta (Step 0 fix round).
  return { searchTermId, keyword: out.keyword, ...window, requestedWeeks: weeks, source: 'chart_series', seriesUpdatedAt: out.series.updated_at, warnings };
}
