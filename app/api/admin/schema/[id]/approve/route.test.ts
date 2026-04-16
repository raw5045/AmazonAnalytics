import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRequireAdmin,
  mockUpdate,
  mockInsert,
  mockInngestSend,
  mockFindFirstSchema,
  mockFindFirstFile,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockUpdate: vi.fn(),
  mockInsert: vi.fn(),
  mockInngestSend: vi.fn(),
  mockFindFirstSchema: vi.fn(),
  mockFindFirstFile: vi.fn(),
}));

vi.mock('@/lib/auth/requireAdmin', () => ({
  requireAdmin: mockRequireAdmin,
  AuthError: class AuthError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

vi.mock('@/db/client', () => ({
  db: {
    update: (...a: unknown[]) => mockUpdate(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      schemaVersions: { findFirst: mockFindFirstSchema },
      uploadedFiles: { findFirst: mockFindFirstFile },
    },
  },
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: mockInngestSend },
}));

import { POST } from './route';

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/admin/schema/v1/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/schema/[id]/approve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('activates the schema and queues data import of the rubric file', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-uuid' });
    mockFindFirstSchema.mockResolvedValueOnce({ id: 'sv-uuid', status: 'draft', versionNumber: 1 });
    mockFindFirstFile.mockResolvedValueOnce({
      id: 'file-uuid',
      storageKey: 'rubrics/abc.csv',
    });
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    mockInsert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    const res = await POST(makeRequest({ fileId: 'file-uuid' }), {
      params: Promise.resolve({ id: 'sv-uuid' }),
    });

    expect(res.status).toBe(200);
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'csv/single.uploaded' }),
    );
  });

  it('rejects when schema version is not in draft', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-uuid' });
    mockFindFirstSchema.mockResolvedValueOnce({ id: 'sv-uuid', status: 'active' });

    const res = await POST(makeRequest({ fileId: 'file-uuid' }), {
      params: Promise.resolve({ id: 'sv-uuid' }),
    });

    expect(res.status).toBe(400);
  });
});
