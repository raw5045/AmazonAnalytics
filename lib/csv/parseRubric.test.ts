import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseRubric, RubricParseError } from './parseRubric';

function loadFixture(name: string): Buffer {
  return readFileSync(path.join(__dirname, 'fixtures', name));
}

describe('parseRubric', () => {
  it('extracts metadata, header, and sample rows from valid file', async () => {
    const buf = loadFixture('valid-sample.csv');
    const result = await parseRubric(buf, { sampleSize: 50 });
    expect(result.metadataRowRaw).toContain('Reporting Range');
    expect(result.weekEndDate).toBe('2026-04-11');
    expect(result.weekStartDate).toBe('2026-04-05');
    expect(result.reportingDateRaw).toBe('4/11/2026');
    expect(result.headers).toHaveLength(21);
    expect(result.headers[0]).toBe('Search Frequency Rank');
    expect(result.headers[20]).toBe('Reporting Date');
    expect(result.sampleRows.length).toBeGreaterThan(10);
  });

  it('throws when required header is missing', async () => {
    const buf = loadFixture('missing-header.csv');
    await expect(parseRubric(buf)).rejects.toThrow(RubricParseError);
  });

  it('throws when reporting dates are inconsistent', async () => {
    const buf = loadFixture('mixed-dates.csv');
    await expect(parseRubric(buf)).rejects.toThrow(/mixed reporting date/i);
  });
});
