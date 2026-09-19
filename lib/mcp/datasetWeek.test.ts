import { describe, it, expect, vi } from 'vitest';

const { limit } = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ limit }) }) } }));

import { currentDatasetWeek } from './datasetWeek';

describe('currentDatasetWeek', () => {
  it('returns the singleton current week end date', async () => {
    limit.mockResolvedValueOnce([{ week: '2026-09-12' }]);
    expect(await currentDatasetWeek()).toBe('2026-09-12');
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('returns null when the meta table is empty (refresh kill switch)', async () => {
    limit.mockResolvedValueOnce([]);
    expect(await currentDatasetWeek()).toBeNull();
  });
});
