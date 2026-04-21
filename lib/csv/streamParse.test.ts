import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { streamParseCsv } from './streamParse';

function streamFromBuffer(buf: Buffer): Readable {
  return Readable.from(buf);
}

describe('streamParseCsv', () => {
  it('parses the real sample fixture and yields rows with header keys', async () => {
    const buf = readFileSync(path.join(__dirname, 'fixtures/valid-sample.csv'));
    const rows: Record<string, string>[] = [];
    for await (const row of streamParseCsv(streamFromBuffer(buf))) {
      rows.push(row);
    }
    expect(rows.length).toBeGreaterThan(90);
    const first = rows[0];
    expect(first['Search Frequency Rank']).toBeTruthy();
    expect(first['Search Term']).toBeTruthy();
    expect(first['Reporting Date']).toMatch(/\d+\/\d+\/\d+/);
  });

  it('strips UTF-8 BOM', async () => {
    const csv = '\uFEFFheader\nvalue\n';
    const rows: Record<string, string>[] = [];
    for await (const row of streamParseCsv(streamFromBuffer(Buffer.from(csv)), { skipMetadataRow: false })) {
      rows.push(row);
    }
    expect(rows[0].header).toBe('value');
  });

  it('skips the first metadata row when skipMetadataRow is true (default)', async () => {
    const csv = 'metadata,cell\nHeader A,Header B\nvalA,valB\n';
    const rows: Record<string, string>[] = [];
    for await (const row of streamParseCsv(streamFromBuffer(Buffer.from(csv)))) {
      rows.push(row);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]['Header A']).toBe('valA');
    expect(rows[0]['Header B']).toBe('valB');
  });
});
