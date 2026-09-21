import { describe, it, expect, vi } from 'vitest';
import { countVolumeInversions, volumeInversionsSql } from './volumeMonotonicity';

describe('volume monotonicity', () => {
  it('counts rank-ordered rows whose estimate rises above the previous one', () => {
    const sql = volumeInversionsSql('keyword_current_summary_stage');
    expect(sql).toContain('lag(estimated_monthly_volume_current) OVER (ORDER BY current_rank, search_term_id)');
    expect(sql).toContain('FROM keyword_current_summary_stage');
    expect(sql).toContain('WHERE prev IS NOT NULL AND v > prev');
    expect(sql).toContain('WHERE estimated_monthly_volume_current IS NOT NULL');
    expect(sql).toContain('count(*)::int AS inversions');
  });

  it('returns the count', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ inversions: 3 }] })) };
    expect(await countVolumeInversions(client, 'keyword_current_summary')).toBe(3);
    expect(client.query).toHaveBeenCalledWith(volumeInversionsSql('keyword_current_summary'));
  });

  it('treats an empty result as zero', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await countVolumeInversions(client, 'keyword_current_summary')).toBe(0);
  });

  it('coerces a string count (as some pg drivers return for bigint/int aggregates)', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ inversions: '7' }] })) };
    expect(await countVolumeInversions(client, 'keyword_current_summary')).toBe(7);
  });
});
