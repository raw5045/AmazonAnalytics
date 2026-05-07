/**
 * Pure data shaping helpers for the keyword detail page.
 *
 * gapFillHistory — merges actual kwm rows with the full 52-week calendar,
 *   emitting null for weeks where the term was not observed. The chart
 *   renders these as breaks in the line.
 *
 * groupTopProductRuns — given the chronological history, groups
 *   consecutive weeks where the top product (slot 1) was the same ASIN.
 *   Output is one row per "run" — useful for the timeline view.
 */
import type { KeywordDetailHistoryRow } from './fetchKeywordDetail';

export interface GapFilledRow {
  weekEndDate: string;
  /** null = term was unranked (no kwm row) that week. */
  actualRank: number | null;
  raw: KeywordDetailHistoryRow | null;
}

/**
 * Build a list of weekly date strings, every 7 days, ending at `latestWeek`,
 * going back exactly `weeks` weeks. Inclusive of latest. Output is oldest
 * first to match chronological chart x-axis order.
 */
export function buildWeekCalendar(latestWeek: string, weeks: number): string[] {
  const out: string[] = [];
  const latest = parseIsoDate(latestWeek);
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(latest);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Given chronological kwm rows + an explicit 52-week calendar, emit one
 * row per calendar week. Missing weeks have `actualRank: null` so the
 * chart can show gaps.
 */
export function gapFillHistory(
  history: KeywordDetailHistoryRow[],
  calendar: string[],
): GapFilledRow[] {
  const byWeek = new Map<string, KeywordDetailHistoryRow>();
  for (const row of history) byWeek.set(row.weekEndDate, row);
  return calendar.map((w) => {
    const r = byWeek.get(w);
    return {
      weekEndDate: w,
      actualRank: r ? r.actualRank : null,
      raw: r ?? null,
    };
  });
}

export interface TopProductRun {
  asin: string;
  title: string | null;
  /** Inclusive start week (oldest week of this run). */
  startWeek: string;
  /** Inclusive end week (newest week of this run). */
  endWeek: string;
  /** Number of weeks this product held the slot. */
  weeks: number;
  /** Average click share over the run, or null if no values. */
  avgClickShare: number | null;
  /** Average conversion share over the run. */
  avgConversionShare: number | null;
}

/**
 * Group consecutive same-ASIN weeks for the top product slot 1.
 * Skips weeks where the ASIN is null (no kwm row, or no top product).
 *
 * Output is chronological (oldest run first).
 */
export function groupTopProductRuns(
  history: KeywordDetailHistoryRow[],
): TopProductRun[] {
  const runs: TopProductRun[] = [];
  let current: { asin: string; title: string | null; weeks: KeywordDetailHistoryRow[] } | null = null;

  for (const row of history) {
    const asin = row.topClickedProduct1Asin;
    if (!asin) {
      // null asin breaks the run
      if (current) {
        runs.push(toRun(current));
        current = null;
      }
      continue;
    }
    if (current && current.asin === asin) {
      current.weeks.push(row);
    } else {
      if (current) runs.push(toRun(current));
      current = {
        asin,
        title: row.topClickedProduct1Title,
        weeks: [row],
      };
    }
  }
  if (current) runs.push(toRun(current));
  return runs;
}

function toRun(g: { asin: string; title: string | null; weeks: KeywordDetailHistoryRow[] }): TopProductRun {
  const clickShares = g.weeks
    .map((w) => parseFloatOrNull(w.topClickedProduct1ClickShare))
    .filter((v): v is number => v !== null);
  const convShares = g.weeks
    .map((w) => parseFloatOrNull(w.topClickedProduct1ConversionShare))
    .filter((v): v is number => v !== null);
  return {
    asin: g.asin,
    title: g.title,
    startWeek: g.weeks[0].weekEndDate,
    endWeek: g.weeks[g.weeks.length - 1].weekEndDate,
    weeks: g.weeks.length,
    avgClickShare: clickShares.length > 0 ? clickShares.reduce((a, b) => a + b, 0) / clickShares.length : null,
    avgConversionShare: convShares.length > 0 ? convShares.reduce((a, b) => a + b, 0) / convShares.length : null,
  };
}

function parseFloatOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseIsoDate(s: string): Date {
  // Handle 'YYYY-MM-DD' explicitly to avoid timezone-shift bugs that
  // `new Date('YYYY-MM-DD')` can introduce in some Node versions.
  const [y, m, d] = s.split('-').map((p) => parseInt(p, 10));
  return new Date(Date.UTC(y, m - 1, d));
}
