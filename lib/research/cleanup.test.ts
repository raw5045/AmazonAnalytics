import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deleteStaleUsageBuckets, STALE_BUCKETS_SQL } from './cleanup';

describe('deleteStaleUsageBuckets', () => {
  it('deletes buckets older than a day and reports the count', async () => {
    const query = vi.fn(async () => ({ rowCount: 42 }));
    expect(await deleteStaleUsageBuckets({ query })).toBe(42);
    expect(query).toHaveBeenCalledWith(STALE_BUCKETS_SQL);
    expect(STALE_BUCKETS_SQL).toMatch(/DELETE FROM research_usage_buckets WHERE bucket_start < now\(\) - interval '1 day'/);
  });

  it('treats a null rowCount as zero', async () => {
    const query = vi.fn(async () => ({ rowCount: null }));
    expect(await deleteStaleUsageBuckets({ query })).toBe(0);
  });

  describe('before migration 0047 has landed', () => {
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it('tolerates a missing relation (SQLSTATE 42P01), warns once, and returns 0', async () => {
      const query = vi.fn(async () => {
        throw Object.assign(new Error('relation "research_usage_buckets" does not exist'), { code: '42P01' });
      });
      expect(await deleteStaleUsageBuckets({ query })).toBe(0);
      expect(console.warn).toHaveBeenCalledWith('[cleanup-research-usage] table not present yet');
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('propagates any other error', async () => {
      const query = vi.fn(async () => {
        throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      });
      await expect(deleteStaleUsageBuckets({ query })).rejects.toThrow('connection terminated');
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('propagates an error with no code at all', async () => {
      const query = vi.fn(async () => {
        throw new Error('socket hang up');
      });
      await expect(deleteStaleUsageBuckets({ query })).rejects.toThrow('socket hang up');
    });
  });
});
