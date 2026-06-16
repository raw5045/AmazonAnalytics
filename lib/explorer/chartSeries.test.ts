import { describe, it, expect } from 'vitest';
import {
  kwmRowToEntry,
  appendWeek,
  seriesToHistoryRows,
  type ChartSeriesKwmRow,
} from './chartSeries';
import { pickFitForWeek, predictVolumeFromFit, type FitParams } from '@/lib/analytics/volumeModel';
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a single-segment FitParams (mirrors fixture helper in volumeModel.test.ts). */
function singleFit(
  calibrationMonthEndDate: string,
  fittedAt: string,
  beta: number,
  scaleFactor: number,
): FitParams {
  return {
    calibrationMonthEndDate,
    fittedAt,
    beta,
    scaleFactor,
    breakpoints: [],
    segments: [{ beta, scaleFactor }],
  };
}

/** Minimal ChartSeriesEntry builder. */
function makeEntry(w: string, r: number, overrides: Partial<ChartSeriesEntry> = {}): ChartSeriesEntry {
  return {
    w,
    r,
    sev: null,
    es: null,
    cs: null,
    vs: null,
    t: [null, null, null],
    tl: [null, null, null],
    ...overrides,
  };
}

/** Build 53 entries with dates 2025-01-05, 2025-01-12, … (weekly). */
function build53Entries(): ChartSeriesEntry[] {
  const entries: ChartSeriesEntry[] = [];
  for (let i = 0; i < 53; i++) {
    // Start 2025-01-05, add 7 days per entry
    const d = new Date(Date.UTC(2025, 0, 5 + i * 7));
    const w = d.toISOString().slice(0, 10);
    entries.push(makeEntry(w, 100 + i));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// kwmRowToEntry
// ---------------------------------------------------------------------------

describe('kwmRowToEntry', () => {
  it('maps string week_end_date to ISO w key', () => {
    const row: ChartSeriesKwmRow = {
      week_end_date: '2026-01-04',
      actual_rank: 50,
      fake_volume_severity: 'warning',
      fake_volume_eval_status: 'evaluated',
      top_clicked_product_1_click_share: '0.25',
      top_clicked_product_1_conversion_share: '0.10',
      keyword_in_title_1: true,
      keyword_in_title_2: false,
      keyword_in_title_3: null,
      keyword_in_title_1_loose: true,
      keyword_in_title_2_loose: true,
      keyword_in_title_3_loose: null,
    };
    const entry = kwmRowToEntry(row);
    expect(entry.w).toBe('2026-01-04');
    expect(entry.r).toBe(50);
    expect(entry.sev).toBe('warning');
    expect(entry.es).toBe('evaluated');
    expect(entry.cs).toBe('0.25');
    expect(entry.vs).toBe('0.10');
    expect(entry.t).toEqual([true, false, null]);
    expect(entry.tl).toEqual([true, true, null]);
  });

  it('normalizes Date object week_end_date to YYYY-MM-DD', () => {
    const row: ChartSeriesKwmRow = {
      week_end_date: new Date('2026-03-22T00:00:00.000Z'),
      actual_rank: 200,
      fake_volume_severity: null,
      fake_volume_eval_status: null,
      top_clicked_product_1_click_share: null,
      top_clicked_product_1_conversion_share: null,
      keyword_in_title_1: null,
      keyword_in_title_2: null,
      keyword_in_title_3: null,
      keyword_in_title_1_loose: null,
      keyword_in_title_2_loose: null,
      keyword_in_title_3_loose: null,
    };
    const entry = kwmRowToEntry(row);
    expect(entry.w).toBe('2026-03-22');
  });

  it('trims ISO timestamp strings to YYYY-MM-DD', () => {
    const row: ChartSeriesKwmRow = {
      week_end_date: '2026-05-10T00:00:00.000Z',
      actual_rank: 1,
      fake_volume_severity: 'critical',
      fake_volume_eval_status: null,
      top_clicked_product_1_click_share: null,
      top_clicked_product_1_conversion_share: null,
      keyword_in_title_1: false,
      keyword_in_title_2: false,
      keyword_in_title_3: false,
      keyword_in_title_1_loose: false,
      keyword_in_title_2_loose: false,
      keyword_in_title_3_loose: false,
    };
    const entry = kwmRowToEntry(row);
    expect(entry.w).toBe('2026-05-10');
  });
});

// ---------------------------------------------------------------------------
// appendWeek
// ---------------------------------------------------------------------------

describe('appendWeek', () => {
  it('appends a new entry to the end', () => {
    const series = [makeEntry('2026-01-04', 100), makeEntry('2026-01-11', 90)];
    const result = appendWeek(series, makeEntry('2026-01-18', 80));
    expect(result.length).toBe(3);
    expect(result[result.length - 1].w).toBe('2026-01-18');
    expect(result[result.length - 1].r).toBe(80);
  });

  it('does not mutate the input array', () => {
    const series = [makeEntry('2026-01-04', 100)];
    const original = [...series];
    appendWeek(series, makeEntry('2026-01-11', 90));
    expect(series).toEqual(original);
  });

  it('drops oldest entry when exceeding cap (default 52)', () => {
    const entries = build53Entries(); // 53 entries
    // appendWeek on a 53-entry series should cap at 52
    // Actually we build 52 then add one more to test the cap:
    const series52 = entries.slice(0, 52);
    const newEntry = entries[52]; // the 53rd
    const result = appendWeek(series52, newEntry, 52);
    expect(result.length).toBe(52);
    // Oldest (index 0) should be dropped
    expect(result[0].w).toBe(entries[1].w);
    expect(result[result.length - 1].w).toBe(entries[52].w);
  });

  it('53 entries in → 52 out, oldest dropped, still chronological', () => {
    const entries = build53Entries();
    const series53 = entries.slice(0, 53);
    // Build a 52-entry series and add the 53rd entry
    const series52 = series53.slice(0, 52);
    const newest = series53[52];
    const result = appendWeek(series52, newest, 52);

    expect(result.length).toBe(52);
    // Verify chronological order
    for (let i = 1; i < result.length; i++) {
      expect(result[i].w > result[i - 1].w).toBe(true);
    }
    // Oldest (entries[0]) was dropped
    expect(result[0].w).toBe(entries[1].w);
    // Newest is at the end
    expect(result[result.length - 1].w).toBe(newest.w);
  });

  it('REPLACES last entry when new entry has same w (idempotent re-import)', () => {
    const series = [
      makeEntry('2026-01-04', 100),
      makeEntry('2026-01-11', 90, { sev: 'warning' }),
    ];
    const updated = makeEntry('2026-01-11', 85, { sev: 'critical' });
    const result = appendWeek(series, updated);
    expect(result.length).toBe(2); // length unchanged
    expect(result[result.length - 1].r).toBe(85);
    expect(result[result.length - 1].sev).toBe('critical');
  });

  it('respects a custom cap value', () => {
    const series = [
      makeEntry('2026-01-04', 100),
      makeEntry('2026-01-11', 90),
      makeEntry('2026-01-18', 80),
    ];
    const result = appendWeek(series, makeEntry('2026-01-25', 70), 3);
    expect(result.length).toBe(3);
    expect(result[0].w).toBe('2026-01-11'); // oldest dropped
  });

  it('keeps all entries when under the cap', () => {
    const series = [makeEntry('2026-01-04', 100), makeEntry('2026-01-11', 90)];
    const result = appendWeek(series, makeEntry('2026-01-18', 80), 52);
    expect(result.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// seriesToHistoryRows
// ---------------------------------------------------------------------------

describe('seriesToHistoryRows', () => {
  const fits: FitParams[] = [
    singleFit('2026-04-30', '2026-05-01T00:00:00Z', 0.75, 2_000_000),
    singleFit('2026-05-31', '2026-06-01T00:00:00Z', 0.74, 1_800_000),
  ];

  it('maps weekEndDate and actualRank correctly', () => {
    const series = [makeEntry('2026-04-27', 500)];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.weekEndDate).toBe('2026-04-27');
    expect(row.actualRank).toBe(500);
  });

  it('estimatedMonthlyVolume matches Math.round(predictVolumeFromFit(r, fit))', () => {
    const w = '2026-04-27';
    const r = 500;
    const series = [makeEntry(w, r)];
    const [row] = seriesToHistoryRows(series, fits);

    const sel = pickFitForWeek(w, fits);
    expect(sel).not.toBeNull();
    const expected = Math.round(predictVolumeFromFit(r, sel!.fit));
    expect(row.estimatedMonthlyVolume).toBe(expected);
    expect(row.estimatedMonthlyVolumeIsExtrapolated).toBe(sel!.isExtrapolated);
  });

  it('estimatedMonthlyVolumeIsExtrapolated is true for weeks before all fits', () => {
    const w = '2026-03-15'; // before April fit
    const r = 1000;
    const series = [makeEntry(w, r)];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.estimatedMonthlyVolumeIsExtrapolated).toBe(true);
    // Volume should still be computed (using earliest fit)
    expect(row.estimatedMonthlyVolume).not.toBeNull();
  });

  it('estimatedMonthlyVolume is null when fits is empty', () => {
    const series = [makeEntry('2026-04-27', 500)];
    const [row] = seriesToHistoryRows(series, []);
    expect(row.estimatedMonthlyVolume).toBeNull();
    expect(row.estimatedMonthlyVolumeIsExtrapolated).toBe(false);
  });

  it('picks the right fit for each week independently', () => {
    const series = [
      makeEntry('2026-04-27', 100), // uses April fit
      makeEntry('2026-05-25', 100), // uses May fit
    ];
    const rows = seriesToHistoryRows(series, fits);

    const selApr = pickFitForWeek('2026-04-27', fits)!;
    const selMay = pickFitForWeek('2026-05-25', fits)!;

    expect(rows[0].estimatedMonthlyVolume).toBe(Math.round(predictVolumeFromFit(100, selApr.fit)));
    expect(rows[1].estimatedMonthlyVolume).toBe(Math.round(predictVolumeFromFit(100, selMay.fit)));
  });

  it('fakeVolumeSeverity is "none" when r > 100000, regardless of stored sev', () => {
    const series = [makeEntry('2026-04-27', 150_000, { sev: 'critical' })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.fakeVolumeSeverity).toBe('none');
  });

  it('fakeVolumeSeverity passes through raw sev when r <= 100000', () => {
    const series = [makeEntry('2026-04-27', 50_000, { sev: 'warning' })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.fakeVolumeSeverity).toBe('warning');
  });

  it('fakeVolumeSeverity is null when sev is null and r <= 100000', () => {
    const series = [makeEntry('2026-04-27', 1000, { sev: null })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.fakeVolumeSeverity).toBeNull();
  });

  it('fakeVolumeEvalStatus maps from es', () => {
    const series = [makeEntry('2026-04-27', 100, { es: 'evaluated' })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.fakeVolumeEvalStatus).toBe('evaluated');
  });

  it('topClickedProduct1ClickShare maps from cs', () => {
    const series = [makeEntry('2026-04-27', 100, { cs: '0.35' })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.topClickedProduct1ClickShare).toBe('0.35');
  });

  it('topClickedProduct1ConversionShare maps from vs', () => {
    const series = [makeEntry('2026-04-27', 100, { vs: '0.12' })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.topClickedProduct1ConversionShare).toBe('0.12');
  });

  it('t[0/1/2] maps to keywordInTitle1/2/3', () => {
    const series = [makeEntry('2026-04-27', 100, { t: [true, false, null] })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.keywordInTitle1).toBe(true);
    expect(row.keywordInTitle2).toBe(false);
    expect(row.keywordInTitle3).toBeNull();
  });

  it('tl[0/1/2] maps to keywordInTitle1/2/3Loose', () => {
    const series = [makeEntry('2026-04-27', 100, { tl: [null, true, false] })];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.keywordInTitle1Loose).toBeNull();
    expect(row.keywordInTitle2Loose).toBe(true);
    expect(row.keywordInTitle3Loose).toBe(false);
  });

  it('all product/category/variant fields are null', () => {
    const series = [makeEntry('2026-04-27', 100)];
    const [row] = seriesToHistoryRows(series, fits);
    expect(row.topClickedProduct1Asin).toBeNull();
    expect(row.topClickedProduct1Title).toBeNull();
    expect(row.topClickedProduct2Asin).toBeNull();
    expect(row.topClickedProduct2Title).toBeNull();
    expect(row.topClickedProduct3Asin).toBeNull();
    expect(row.topClickedProduct3Title).toBeNull();
    expect(row.topClickedCategory1).toBeNull();
    expect(row.keywordTitleMatchCount).toBeNull();
    expect(row.keywordTitleMatchCountLoose).toBeNull();
    expect(row.variants).toBeNull();
  });

  it('handles empty series, returning empty array', () => {
    const rows = seriesToHistoryRows([], fits);
    expect(rows).toEqual([]);
  });

  it('processes multiple entries in order', () => {
    const series = [
      makeEntry('2026-04-20', 200),
      makeEntry('2026-04-27', 180),
      makeEntry('2026-05-04', 160),
    ];
    const rows = seriesToHistoryRows(series, fits);
    expect(rows.length).toBe(3);
    expect(rows[0].weekEndDate).toBe('2026-04-20');
    expect(rows[1].weekEndDate).toBe('2026-04-27');
    expect(rows[2].weekEndDate).toBe('2026-05-04');
  });
});
