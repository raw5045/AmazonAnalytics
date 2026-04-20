import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { mockDownloadStream, mockExecute, mockDelete, mockUpdate, mockInsert, mockFindFile } =
  vi.hoisted(() => ({
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

describe('processFileImport', () => {
  beforeEach(() => vi.clearAllMocks());

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

    const result = await processFileImport({ uploadedFileId: 'f1' });
    expect(result.rowsImported).toBeGreaterThan(90);
    expect(mockInsert).toHaveBeenCalled();
  });
});
