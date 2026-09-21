import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockOnConflictDoUpdate, mockValues, mockInsert } = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockOnConflictDoUpdate, mockValues, mockInsert };
});

vi.mock('@/db/client', () => ({ db: { insert: mockInsert } }));

import { bumpUserActivityBy } from './bump';

describe('bumpUserActivityBy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('makes no DB call for by <= 0 or a non-integer', async () => {
    await bumpUserActivityBy('u1', 'mcp_rows', 0);
    await bumpUserActivityBy('u1', 'mcp_rows', -5);
    await bumpUserActivityBy('u1', 'mcp_rows', 1.5);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('inserts/upserts with count = by for a positive integer', async () => {
    await bumpUserActivityBy('u1', 'mcp_rows', 37);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', metric: 'mcp_rows', count: 37 }));
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('swallows a DB error to console.warn instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOnConflictDoUpdate.mockRejectedValueOnce(new Error('db down'));
    await expect(bumpUserActivityBy('u1', 'mcp_rows', 5)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
