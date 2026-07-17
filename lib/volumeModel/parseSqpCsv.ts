/**
 * Parser for Brand Analytics Search Query Performance CSV exports
 * (spec docs/superpowers/specs/2026-07-16-sqp-calibration-design.md §2).
 *
 * Format: line 1 = metadata (Brand=[…],Reporting Range=[…],Select month=[…]),
 * line 2 = quoted header, then quoted data rows. "Search Query Volume" is the
 * marketplace-wide unique-customer query count for the period.
 */
import { normalizeForMatch } from '@/lib/analytics/derivedFields';

export class SqpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqpParseError';
  }
}

export interface ParsedSqpRow {
  searchTermNormalized: string;
  monthlyVolume: number;
}

export interface ParsedSqpFile {
  rows: ParsedSqpRow[];
  /**
   * Month-end date parsed from the `Select month=[…]` metadata (the second
   * ISO date in the bracket), or null (e.g. weekly files). The admin form's
   * month field stays authoritative; this only pre-fills it.
   */
  suggestedMonthEndDate: string | null;
  /** Raw metadata line, for provenance/debug display. */
  metadata: string;
}

/** Minimal RFC-4180 parser: quoted fields, embedded commas, doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function parseSqpCsv(text: string): ParsedSqpFile {
  const raw = parseCsv(text);
  if (raw.length < 2) throw new SqpParseError('File too short: expected metadata line + header');
  const metadata = raw[0].join(',');
  const header = raw[1];
  const qi = header.indexOf('Search Query');
  const vi = header.indexOf('Search Query Volume');
  if (qi < 0 || vi < 0) {
    throw new SqpParseError('Missing required columns "Search Query" / "Search Query Volume" — is this an SQP export?');
  }

  const byTerm = new Map<string, number>();
  for (const r of raw.slice(2)) {
    if (r.length <= Math.max(qi, vi)) continue;
    const term = normalizeForMatch(r[qi]);
    const volume = parseInt(r[vi].replace(/,/g, ''), 10);
    if (!term || !Number.isFinite(volume) || volume <= 0) continue;
    byTerm.set(term, Math.max(byTerm.get(term) ?? 0, volume));
  }

  // `Select month=["June | 2026-06-01 - 2026-06-30 2026"]` → second ISO date.
  // parseCsv strips the quotes inside the brackets (raw[0].join(',') yields
  // `Select month=[June | …]`), so match bracket content with or without
  // quotes; [^\]] keeps the match from leaking past the closing bracket.
  let suggestedMonthEndDate: string | null = null;
  const m = metadata.match(/Select month=\[[^\]]*?(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  if (m) suggestedMonthEndDate = m[2];

  return {
    rows: [...byTerm.entries()].map(([searchTermNormalized, monthlyVolume]) => ({ searchTermNormalized, monthlyVolume })),
    suggestedMonthEndDate,
    metadata,
  };
}
