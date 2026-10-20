import { describe, it, expect } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
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

  // .pipe() never forwarded errors: the source's 'error' went unhandled and killed the worker on
  // 2026-10-19. The chain must hand a source error to the consumer's for-await instead.
  it('rejects with an error the input emits mid-stream, after yielding the rows before it', async () => {
    const input = new PassThrough();
    // A body mid-transfer: one whole record, then a partial one. (csv-parse holds a record until it
    // has look-ahead past its delimiter, so without the partial tail '1,2' would never be emitted.)
    input.write('a,b\n1,2\n3,4');
    const boom = new Error('boom');
    const rows: Record<string, string>[] = [];

    const consume = async () => {
      for await (const row of streamParseCsv(input, { skipMetadataRow: false })) {
        rows.push(row);
        input.destroy(boom); // the source dies mid-stream, as the R2 body did
      }
    };

    await expect(consume()).rejects.toBe(boom);
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('propagates an R2StreamError-like error through the metadata-row stage with its name and code intact', async () => {
    const input = new PassThrough();
    input.write('metadata,cell\nHeader A,Header B\n');
    const stalled = Object.assign(new Error('R2 stream k inactive for 120000ms'), {
      name: 'R2StreamError',
      code: 'r2_stream_inactive',
    });
    setImmediate(() => input.destroy(stalled));

    const consume = async () => {
      for await (const row of streamParseCsv(input)) {
        throw new Error(`unexpected row ${JSON.stringify(row)}`);
      }
    };
    const caught = await consume().then(
      () => null,
      (e: unknown) => e,
    );

    expect(caught).toBe(stalled);
    expect(caught).toMatchObject({ name: 'R2StreamError', code: 'r2_stream_inactive' });
  });
});
