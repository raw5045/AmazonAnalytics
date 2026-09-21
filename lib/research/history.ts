import type { Pool } from 'pg';
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';
import { withReadOnlyTx } from '@/lib/db/tcpPool';
import type { FitParams } from '@/lib/analytics/volumeModel';
import { seriesToHistoryRows } from '@/lib/explorer/chartSeries';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import type { HistoryPoint, KeywordHistoryResponse, Severity, Warning } from './contracts';
import { ResearchError, dataUnavailableError, queryTimeoutError } from './errors';
import { loadSnapshotMeta } from './snapshot';

/** 'YYYY-MM-DD' shifted by whole days in UTC. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Parent §11.5: the calendar window ending at the dataset week; absent weeks are missing observations, never zeros. */
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

export interface HistoryDeps { pool: Pool; timeoutMs: number; fetchFits: () => Promise<FitParams[]> }

export async function loadKeywordHistory(searchTermId: string, weeks: number, deps: HistoryDeps): Promise<KeywordHistoryResponse> {
  const out = await withReadOnlyTx(deps.pool, deps.timeoutMs, async (client) => {
    const meta = await loadSnapshotMeta(client);
    if (!meta) throw dataUnavailableError();
    const term = (await client.query('SELECT search_term_raw FROM search_terms WHERE id = $1', [searchTermId])).rows[0] as { search_term_raw: string } | undefined;
    if (!term) throw new ResearchError('KEYWORD_NOT_FOUND', 'No keyword exists with that id.');
    const series = (await client.query(
      `SELECT series, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
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
