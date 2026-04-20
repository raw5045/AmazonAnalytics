import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { mockDownloadStream, mockUpdate, mockInsert, mockFindFile, mockFindReportingWeek } =
  vi.hoisted(() => ({
    mockDownloadStream: vi.fn(),
    mockUpdate: vi.fn(),
    mockInsert: vi.fn(),
    mockFindFile: vi.fn(),
    mockFindReportingWeek: vi.fn(),
  }));

vi.mock('@/lib/storage/r2', () => ({
  downloadStreamFromR2: mockDownloadStream,
}));

vi.mock('@/db/client', () => ({
  db: {
    update: (...a: unknown[]) => mockUpdate(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      uploadedFiles: { findFirst: mockFindFile },
      reportingWeeks: { findFirst: mockFindReportingWeek },
    },
  },
}));

import { processFileValidation } from './validate';

describe('processFileValidation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates a clean file and marks it pass', async () => {
    const buf = readFileSync(path.join(__dirname, '../../lib/csv/fixtures/valid-sample.csv'));
    mockFindFile.mockResolvedValueOnce({ id: 'f1', storageKey: 'k', batchId: 'b1' });
    mockFindReportingWeek.mockResolvedValueOnce(undefined);
    mockDownloadStream.mockResolvedValueOnce(Readable.from(buf));
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    const result = await processFileValidation({ uploadedFileId: 'f1' });
    expect(result.outcome).toBe('pass');
  });
});
