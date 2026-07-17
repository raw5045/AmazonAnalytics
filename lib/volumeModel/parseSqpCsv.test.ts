import { describe, it, expect } from 'vitest';
import { parseSqpCsv, SqpParseError } from './parseSqpCsv';

const HEADER = '"Search Query","Search Query Score","Search Query Volume","Impressions: Total Count","Reporting Date"';

const file = (meta: string, rows: string[]) => [meta, HEADER, ...rows].join('\n');

describe('parseSqpCsv', () => {
  it('parses rows, normalizes terms, and integers volumes', () => {
    const out = parseSqpCsv(file('Brand=["X"],Reporting Range=["Monthly"],Select month=["June | 2026-06-01 - 2026-06-30 2026"]', [
      '"collagen peptides","702","103376","2779737","2026-06-30"',
      '"Nature\'s Magnesium, Extra","1","1,234","10","2026-06-30"',
    ]));
    expect(out.rows).toEqual([
      { searchTermNormalized: 'collagen peptides', monthlyVolume: 103376 },
      { searchTermNormalized: 'natures magnesium extra', monthlyVolume: 1234 },
    ]);
  });

  it('keeps MAX volume on duplicate normalized terms', () => {
    const out = parseSqpCsv(file('Brand=["X"]', [
      '"vitamin d3","1","100","1","2026-06-30"',
      '"Vitamin D3","1","250","1","2026-06-30"',
    ]));
    expect(out.rows).toEqual([{ searchTermNormalized: 'vitamin d3', monthlyVolume: 250 }]);
  });

  it('extracts the suggested month end date from Select month metadata', () => {
    const out = parseSqpCsv(file('Reporting Range=["Monthly"],Select month=["June | 2026-06-01 - 2026-06-30 2026"]', [
      '"a term","1","10","1","2026-06-30"',
    ]));
    expect(out.suggestedMonthEndDate).toBe('2026-06-30');
  });

  it('suggests null for weekly files (no Select month)', () => {
    const out = parseSqpCsv(file('Reporting Range=["Weekly"],Select week=["Week 28 | 2026-07-05 - 2026-07-11 2026"]', [
      '"a term","1","10","1","2026-07-11"',
    ]));
    expect(out.suggestedMonthEndDate).toBeNull();
  });

  it('skips rows with empty terms or non-numeric volumes', () => {
    const out = parseSqpCsv(file('Brand=["X"]', [
      '"","1","10","1","2026-06-30"',
      '"ok term","1","not a number","1","2026-06-30"',
      '"good term","1","42","1","2026-06-30"',
    ]));
    expect(out.rows).toEqual([{ searchTermNormalized: 'good term', monthlyVolume: 42 }]);
  });

  it('throws SqpParseError when required columns are missing', () => {
    expect(() => parseSqpCsv(['meta', '"Search Query","Something Else"', '"a","1"'].join('\n')))
      .toThrow(SqpParseError);
  });

  it('handles quoted fields containing commas and escaped quotes', () => {
    const out = parseSqpCsv(file('Brand=["X"]', [
      '"magnesium ""extra"", strong","1","5,000","1","2026-06-30"',
    ]));
    expect(out.rows[0].searchTermNormalized).toBe('magnesium extra strong');
    expect(out.rows[0].monthlyVolume).toBe(5000);
  });
});
