import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const {
  mockDownloadStream,
  mockExecute,
  mockDelete,
  mockUpdate,
  mockInsert,
  mockFindFile,
  mockPoolConnect,
  mockPoolEnd,
  mockClientRelease,
  mockClientQuery,
} = vi.hoisted(() => ({
  mockDownloadStream: vi.fn(),
  mockExecute: vi.fn().mockResolvedValue(undefined),
  mockDelete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  mockUpdate: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  }),
  mockInsert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  mockFindFile: vi.fn(),
  mockPoolConnect: vi.fn(),
  mockPoolEnd: vi.fn().mockResolvedValue(undefined),
  mockClientRelease: vi.fn(),
  mockClientQuery: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    connect = mockPoolConnect;
    end = mockPoolEnd;
    on = vi.fn();
  },
}));

vi.mock('pg-copy-streams', () => ({
  from: vi.fn((_sql: string) => _sql),
}));

vi.mock('@/lib/storage/r2', () => ({ downloadStreamFromR2: mockDownloadStream }));
vi.mock('@/db/client', () => ({
  db: {
    execute: mockExecute,
    delete: mockDelete,
    update: mockUpdate,
    insert: mockInsert,
    query: {
      uploadedFiles: { findFirst: mockFindFile },
    },
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        execute: mockExecute,
        insert: mockInsert,
        update: mockUpdate,
        delete: mockDelete,
      }),
    ),
  },
}));

import { processFileImport } from './importFile';

function createFakeCopyStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe('processFileImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolEnd.mockResolvedValue(undefined);
  });

  it('streams the fixture through staging and into keyword_weekly_metrics', async () => {
    const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
    mockFindFile.mockResolvedValueOnce({
      id: 'f1',
      batchId: 'b1',
      storageKey: 'k',
      weekEndDate: '2026-04-11',
      isReplacement: false,
    });
    mockDownloadStream.mockResolvedValueOnce(Readable.from(buf));

    const { stream: copyStream, lines } = createFakeCopyStream();
    mockClientQuery.mockReturnValueOnce(copyStream);
    mockPoolConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: mockClientRelease,
    });

    const result = await processFileImport({ uploadedFileId: 'f1' });
    expect(result.rowsImported).toBeGreaterThan(90);
    expect(lines.length).toBe(result.rowsImported);
    expect(mockClientRelease).toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalled();
  });
});
