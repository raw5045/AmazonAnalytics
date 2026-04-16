import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDownloadFromR2,
  mockParseRubric,
  mockInsert,
  mockUpdate,
  mockExecute,
} = vi.hoisted(() => ({
  mockDownloadFromR2: vi.fn(),
  mockParseRubric: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockExecute: vi.fn(),
}));

vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: mockDownloadFromR2 }));
vi.mock('@/lib/csv/parseRubric', () => ({
  parseRubric: mockParseRubric,
  REQUIRED_COLUMNS: ['col1', 'col2'],
}));
vi.mock('@/db/client', () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    execute: (...a: unknown[]) => mockExecute(...a),
  },
}));

import { processRubricUpload } from './rubric';

describe('processRubricUpload step function', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloads, parses, and creates a draft schema version', async () => {
    mockDownloadFromR2.mockResolvedValueOnce(Buffer.from('fake'));
    mockParseRubric.mockResolvedValueOnce({
      metadataRowRaw: 'meta',
      headers: Array(21).fill('col'),
      headerRowIndex: 1,
      weekStartDate: '2026-04-05',
      weekEndDate: '2026-04-11',
      reportingDateRaw: '4/11/2026',
      sampleRows: [{}],
    });
    mockExecute.mockResolvedValueOnce([{ nextVersion: 1 }]);
    mockInsert.mockReturnValueOnce({
      values: vi.fn().mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 'schema-v1-uuid', versionNumber: 1 }]),
      }),
    });
    mockUpdate.mockReturnValueOnce({
      set: vi.fn().mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce(undefined),
      }),
    });

    const result = await processRubricUpload({
      uploadedFileId: 'file-uuid',
      storageKey: 'uploads/test.csv',
    });

    expect(result.schemaVersionId).toBe('schema-v1-uuid');
    expect(mockDownloadFromR2).toHaveBeenCalledWith('uploads/test.csv');
    expect(mockParseRubric).toHaveBeenCalled();
  });
});
