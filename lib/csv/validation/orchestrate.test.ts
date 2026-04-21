import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateCsvStream } from './orchestrate';

function streamFromPath(p: string): Readable {
  return Readable.from(readFileSync(p));
}

describe('validateCsvStream (on real sample fixture)', () => {
  it('produces pass outcome for the valid sample', async () => {
    const result = await validateCsvStream({
      stream: streamFromPath(path.join(__dirname, '../fixtures/valid-sample.csv')),
      rollingAvgRowCount: undefined,
      rollingAvgBlankShareRate: undefined,
    });
    expect(result.outcome).toBe('pass');
    expect(result.stats.rowCount).toBeGreaterThan(90);
    expect(result.errors).toEqual([]);
  });

  it('detects mixed reporting dates as fail', async () => {
    const result = await validateCsvStream({
      stream: streamFromPath(path.join(__dirname, '../fixtures/mixed-dates.csv')),
      rollingAvgRowCount: undefined,
      rollingAvgBlankShareRate: undefined,
    });
    expect(result.outcome).toBe('fail');
    expect(result.errors.some((e) => e.code === 'MIXED_REPORTING_DATE')).toBe(true);
  });
});
