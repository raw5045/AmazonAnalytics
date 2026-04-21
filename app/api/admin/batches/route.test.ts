import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockInsert, mockFindMany } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockInsert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'new-batch-id' }]),
    }),
  }),
  mockFindMany: vi.fn().mockResolvedValue([{ id: 'b1', status: 'imported' }]),
}));

vi.mock('@/lib/auth/requireAdmin', () => ({
  requireAdmin: mockRequireAdmin,
  AuthError: class extends Error { constructor(public code: string, msg: string) { super(msg); } },
}));

vi.mock('@/db/client', () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      uploadBatches: { findMany: mockFindMany },
    },
  },
}));

import { POST, GET } from './route';

describe('POST /api/admin/batches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new batch and returns its id', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-1' });
    const req = new Request('http://localhost/api/admin/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchType: 'bulk' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.batchId).toBe('new-batch-id');
  });
});

describe('GET /api/admin/batches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns list of batches', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ id: 'user-1' });
    const res = await GET(new Request('http://localhost/api/admin/batches'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.batches).toHaveLength(1);
  });
});
