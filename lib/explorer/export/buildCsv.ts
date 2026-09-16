import type { ExplorerRow, MatchMode, WindowKey } from '../types';

/**
 * Explorer CSV export — pure builder. See
 * docs/superpowers/specs/2026-09-16-explorer-csv-export-design.md.
 *
 * Owner-chosen caps: 10,000 rows per export (the explorer's own paging
 * ceiling) and 10 exports per user per ET day (enforced by the route via the
 * `explorer_export` activity counter).
 */
export const EXPORT_ROW_CAP = 10_000;
export const EXPORTS_PER_DAY = 10;

export interface CsvOptions {
  window: WindowKey;
  /** Which title-match flags to emit: Amazon's strict ones or our loose ones — mirrors the page. */
  matchMode: MatchMode;
  /** Base URL for the KeywordQuarry detail links, e.g. https://keywordquarry.com */
  appUrl: string;
}

type Cell = string | number | boolean | null | undefined;

/**
 * RFC 4180 escaping plus a spreadsheet formula-injection guard: a string
 * beginning with = + - @ (or a tab / carriage return, per OWASP) would be
 * evaluated by Excel/Sheets, so it gets a leading apostrophe. The apostrophe
 * is visible in the spreadsheet for the rare keyword that genuinely starts
 * with one of those characters — accepted. Numbers are emitted verbatim (a
 * negative delta is data).
 */
export function csvEscape(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportHeader(o: Pick<CsvOptions, 'window' | 'matchMode'>): string[] {
  return [
    'Search term',
    'Current rank',
    `Prior rank (${o.window})`,
    'Rank movement',
    'Est. monthly volume',
    `Volume prior (${o.window})`,
    `Volume change (${o.window})`,
    'Avg price USD (top-3)',
    'Avg reviews (top-3)',
    'Fake volume',
    'In title #1',
    'In title #2',
    'In title #3',
    'Title matches (of 3)',
    'Category',
    'Leaf category',
    'Top clicked ASIN',
    'Top clicked title',
    'Top clicked click share %',
    'Top clicked conversion share %',
    'Amazon search URL',
    'KeywordQuarry URL',
  ];
}

// UTF-8 byte-order mark so Excel opens the file as UTF-8 (keywords contain
// accented and non-Latin characters). Built from a code point rather than a
// literal escape on purpose.
const BOM = String.fromCharCode(0xfeff);

/** BOM + header line (CRLF-terminated) — the first chunk of a streamed export. */
export function csvHeaderLine(o: Pick<CsvOptions, 'window' | 'matchMode'>): string {
  return BOM + exportHeader(o).map(csvEscape).join(',') + '\r\n';
}

/** One CRLF-terminated CSV line for a row, columns per exportHeader. */
export function csvRowLine(r: ExplorerRow, o: CsvOptions): string {
  const loose = o.matchMode === 'loose';
  const cells: Cell[] = [
    r.searchTermRaw,
    r.currentRank,
    r.priorRank,
    r.improvement,
    r.estimatedMonthlyVolumeCurrent,
    r.volumePrior,
    r.volumeDelta,
    r.avgPriceCents === null ? null : (r.avgPriceCents / 100).toFixed(2),
    r.avgReviews,
    r.fakeVolumeSeverity,
    loose ? r.keywordInTitle1Loose : r.keywordInTitle1,
    loose ? r.keywordInTitle2Loose : r.keywordInTitle2,
    loose ? r.keywordInTitle3Loose : r.keywordInTitle3,
    loose ? r.keywordTitleMatchCountLoose : r.keywordTitleMatchCount,
    r.topClickedCategory1,
    r.topClickedLeafCategory,
    r.topClickedProduct1Asin,
    r.topClickedProduct1Title,
    r.topClickedProduct1ClickShare,
    r.topClickedProduct1ConversionShare,
    `https://www.amazon.com/s?k=${encodeURIComponent(r.searchTermRaw)}`,
    `${o.appUrl}/explorer/keyword/${r.searchTermId}`,
  ];
  return cells.map(csvEscape).join(',') + '\r\n';
}

/** The whole file as one string (tests, small exports); the route streams the same pieces. */
export function buildExplorerCsv(rows: ExplorerRow[], o: CsvOptions): string {
  return csvHeaderLine(o) + rows.map((r) => csvRowLine(r, o)).join('');
}
