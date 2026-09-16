import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockWhere } = vi.hoisted(() => ({ mockWhere: vi.fn() }));

vi.mock('@/db/client', () => ({
  db: { select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: mockWhere }) }) },
}));

import { countUserActivityToday } from './readToday';

describe('countUserActivityToday', () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns today's count for the user and metric", async () => {
    mockWhere.mockResolvedValueOnce([{ count: 3 }]);
    expect(await countUserActivityToday('u1', 'explorer_export')).toBe(3);
  });

  it('returns 0 when there is no row yet today', async () => {
    mockWhere.mockResolvedValueOnce([]);
    expect(await countUserActivityToday('u1', 'explorer_export')).toBe(0);
  });

  it('propagates database errors (the caller decides how to fail)', async () => {
    mockWhere.mockRejectedValueOnce(new Error('db down'));
    await expect(countUserActivityToday('u1', 'explorer_export')).rejects.toThrow('db down');
  });
});
