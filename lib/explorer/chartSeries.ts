/**
 * Pure chart-series helpers for the keyword detail page.
 *
 * These three functions mediate between:
 *   - keyword_weekly_metrics (kwm) rows — the authoritative source
 *   - ChartSeriesEntry[] stored in keyword_chart_series.series — the compact cache
 *   - KeywordDetailHistoryRow[] — the shape the detail-page charts consume
 *
 * Having volume derivation here (seriesToHistoryRows) must be IDENTICAL
 * to mapHistory in fetchKeywordDetail.ts, so charts render the same whether
 * fed from the series cache or from a live kwm query.
 */

import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';
import type { KeywordDetailHistoryRow } from './fetchKeywordDetail';
import type { SeverityKey } from './types';
import { pickFitForWeek, predictVolumeFromFit, type FitParams } from '@/lib/analytics/volumeModel';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/**
 * The kwm columns needed to build a ChartSeriesEntry. The driver may
 * return week_end_date as a Date object or a string; both are handled.
 */
export interface ChartSeriesKwmRow {
  week_end_date: string | Date;
  actual_rank: number;
  fake_volume_severity: string | null;
  fake_volume_eval_status: string | null;
  top_clicked_product_1_click_share: string | null;
  top_clicked_product_1_conversion_share: string | null;
  keyword_in_title_1: boolean | null;
  keyword_in_title_2: boolean | null;
  keyword_in_title_3: boolean | null;
  keyword_in_title_1_loose: boolean | null;
  keyword_in_title_2_loose: boolean | null;
  keyword_in_title_3_loose: boolean | null;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Normalize a Postgres date column to 'YYYY-MM-DD'.
 * Mirrors the toIsoDate helper in fetchKeywordDetail.ts.
 */
function toIsoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. kwmRowToEntry
// ---------------------------------------------------------------------------

/**
 * Convert one raw kwm row into the compact ChartSeriesEntry stored in
 * keyword_chart_series.series.
 *
 * NOTE: severity is stored RAW (no rank>100k mask here). The mask is
 * applied at render time in seriesToHistoryRows, mirroring how
 * fetchKeywordDetail applies it only at read time.
 */
export function kwmRowToEntry(row: ChartSeriesKwmRow): ChartSeriesEntry {
  return {
    w: toIsoDate(row.week_end_date),
    r: row.actual_rank,
    sev: row.fake_volume_severity,
    es: row.fake_volume_eval_status,
    cs: row.top_clicked_product_1_click_share,
    vs: row.top_clicked_product_1_conversion_share,
    t: [row.keyword_in_title_1, row.keyword_in_title_2, row.keyword_in_title_3],
    tl: [row.keyword_in_title_1_loose, row.keyword_in_title_2_loose, row.keyword_in_title_3_loose],
  };
}

// ---------------------------------------------------------------------------
// 2. appendWeek
// ---------------------------------------------------------------------------

/**
 * Pure append-and-trim for the series cache.
 *
 * Rules:
 *   - Series is chronological oldest→newest.
 *   - If the last entry's `w` equals `entry.w`, REPLACE it (idempotent
 *     re-import) rather than duplicating.
 *   - After adding/replacing, keep only the most-recent `cap` entries
 *     (drop from the front).
 *
 * Returns a new array; never mutates the input.
 */
export function appendWeek(
  series: ChartSeriesEntry[],
  entry: ChartSeriesEntry,
  cap = 52,
): ChartSeriesEntry[] {
  let next: ChartSeriesEntry[];

  const last = series[series.length - 1];
  if (last !== undefined && last.w === entry.w) {
    // Replace the last entry (idempotent re-import)
    next = [...series.slice(0, series.length - 1), entry];
  } else {
    next = [...series, entry];
  }

  // Trim to the most-recent `cap` entries
  if (next.length > cap) {
    next = next.slice(next.length - cap);
  }

  return next;
}

// ---------------------------------------------------------------------------
// 3. seriesToHistoryRows
// ---------------------------------------------------------------------------

/**
 * Convert a compact ChartSeriesEntry[] into KeywordDetailHistoryRow[],
 * deriving volume identically to mapHistory in fetchKeywordDetail.ts.
 *
 * Fields not stored in the series (product ASINs/titles, categories,
 * variants, keywordTitleMatchCount) are set to null — the four charts
 * rendered from this data never read them (confirmed: all are nullable
 * in KeywordDetailHistoryRow).
 */
export function seriesToHistoryRows(
  series: ChartSeriesEntry[],
  fits: ReadonlyArray<FitParams>,
): KeywordDetailHistoryRow[] {
  return series.map((entry) => {
    const { w, r, sev, es, cs, vs, t, tl } = entry;

    // Volume — EXACT mirror of mapHistory in fetchKeywordDetail.ts
    const sel = pickFitForWeek(w, fits);
    const estimatedMonthlyVolume = sel ? Math.round(predictVolumeFromFit(r, sel.fit)) : null;
    const estimatedMonthlyVolumeIsExtrapolated = sel?.isExtrapolated ?? false;

    // Severity mask — apply the same rank>100k gate as the SQL CASE in
    // fetchKeywordDetail (and importFile.ts FAKE_VOLUME_RANK_THRESHOLD).
    const fakeVolumeSeverity: SeverityKey | null =
      r > 100_000 ? 'none' : (sev as SeverityKey | null);

    return {
      weekEndDate: w,
      actualRank: r,
      // Product/category fields not stored in series → null
      topClickedProduct1Asin: null,
      topClickedProduct1Title: null,
      topClickedProduct1ClickShare: cs,
      topClickedProduct1ConversionShare: vs,
      topClickedProduct2Asin: null,
      topClickedProduct2Title: null,
      topClickedProduct3Asin: null,
      topClickedProduct3Title: null,
      topClickedCategory1: null,
      // Strict title-match flags from t[]
      keywordInTitle1: t[0],
      keywordInTitle2: t[1],
      keywordInTitle3: t[2],
      keywordTitleMatchCount: null,
      // Loose title-match flags from tl[]
      keywordInTitle1Loose: tl[0],
      keywordInTitle2Loose: tl[1],
      keywordInTitle3Loose: tl[2],
      keywordTitleMatchCountLoose: null,
      // Volume model
      fakeVolumeSeverity,
      fakeVolumeEvalStatus: es,
      estimatedMonthlyVolume,
      estimatedMonthlyVolumeIsExtrapolated,
      // Variants not stored in series
      variants: null,
    };
  });
}
