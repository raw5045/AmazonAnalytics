import { describe, it, expect } from 'vitest';
import { buildExplorerCsv, csvEscape, exportHeader, EXPORT_ROW_CAP, EXPORTS_PER_DAY } from './buildCsv';
import type { ExplorerRow } from '../types';

const row = (o: Partial<ExplorerRow> = {}): ExplorerRow => ({
  searchTermId: '11111111-2222-3333-4444-555555555555',
  searchTermRaw: 'magnesium glycinate',
  currentRank: 1234,
  priorRank: 2000,
  improvement: 766,
  topClickedCategory1: 'Health & Household',
  fakeVolumeSeverity: 'none',
  keywordTitleMatchCount: 2,
  keywordInTitle1: true,
  keywordInTitle2: true,
  keywordInTitle3: false,
  keywordTitleMatchCountLoose: 3,
  keywordInTitle1Loose: true,
  keywordInTitle2Loose: true,
  keywordInTitle3Loose: true,
  topClickedProduct1Asin: 'B000000001',
  topClickedProduct1Title: 'Magnesium Glycinate 400mg, "Pure"',
  topClickedProduct1ClickShare: '12.34',
  topClickedProduct1ConversionShare: '2.5',
  estimatedMonthlyVolumeCurrent: 48210,
  volumePrior: 30000,
  volumeDelta: 18210,
  avgPriceCents: 1999,
  avgReviews: 4321,
  topClickedLeafCategory: 'Health & Household › Magnesium',
  ...o,
});

const opts = { window: '1w' as const, matchMode: 'strict' as const, appUrl: 'https://keywordquarry.com' };
const lines = (csv: string) => csv.slice(1).split('\r\n');

describe('csvEscape', () => {
  it('leaves plain values alone and quotes commas, quotes, and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection on strings only', () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvEscape('+1 protein')).toBe("'+1 protein");
    expect(csvEscape('-x')).toBe("'-x");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape(-766)).toBe('-766'); // a negative number is data, not a formula
  });

  it('renders null/undefined as empty, booleans as yes/no, numbers verbatim', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(true)).toBe('yes');
    expect(csvEscape(false)).toBe('no');
    expect(csvEscape(12345)).toBe('12345');
  });
});

describe('buildExplorerCsv', () => {
  it('starts with a UTF-8 BOM and the header row, one CRLF-terminated line per row', () => {
    const csv = buildExplorerCsv([row(), row({ searchTermRaw: 'zinc' })], opts);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const l = lines(csv);
    expect(l[0]).toBe(exportHeader(opts).join(','));
    expect(l).toHaveLength(4); // header + 2 rows + trailing terminator
    expect(l[1].startsWith('magnesium glycinate,1234,2000,766,48210,30000,18210,19.99,4321,none,')).toBe(true);
    expect(l[2].startsWith('zinc,')).toBe(true);
  });

  it('labels window-relative columns with the window and picks strict vs loose title flags by match mode', () => {
    const header = exportHeader({ ...opts, window: '4w' });
    expect(header).toContain('Prior rank (4w)');
    expect(header).toContain('Volume change (4w)');
    const strict = lines(buildExplorerCsv([row()], opts))[1];
    const loose = lines(buildExplorerCsv([row()], { ...opts, matchMode: 'loose' }))[1];
    expect(strict).toContain(',none,yes,yes,no,2,');
    expect(loose).toContain(',none,yes,yes,yes,3,');
  });

  it('includes Amazon search and KeywordQuarry detail URLs', () => {
    const line = lines(buildExplorerCsv([row()], opts))[1];
    expect(line).toContain('https://www.amazon.com/s?k=magnesium%20glycinate');
    expect(line).toContain('https://keywordquarry.com/explorer/keyword/11111111-2222-3333-4444-555555555555');
  });

  it('quotes a product title containing a comma and quotes', () => {
    const line = lines(buildExplorerCsv([row()], opts))[1];
    expect(line).toContain('"Magnesium Glycinate 400mg, ""Pure"""');
  });

  it('renders unknowns as empty cells', () => {
    const line = lines(
      buildExplorerCsv([row({ priorRank: null, improvement: null, avgPriceCents: null, fakeVolumeSeverity: null })], opts),
    )[1];
    expect(line.startsWith('magnesium glycinate,1234,,,48210,30000,18210,,4321,,')).toBe(true);
  });

  it('exposes the caps the owner chose', () => {
    expect(EXPORT_ROW_CAP).toBe(10_000);
    expect(EXPORTS_PER_DAY).toBe(10);
  });
});
