// db/schema/keywordTopAsins.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordTopAsinsMeta, asinProducts } from '@/db/schema';

describe('keyword_top_asins schema (migration 0051)', () => {
  it('mirrors the migration columns', () => {
    const cols = Object.values(getTableColumns(keywordTopAsins)).map((c) => c.name).sort();
    expect(cols).toEqual(
      ['asin', 'click_share', 'conversion_share', 'search_term_id', 'slot', 'streak_started_week', 'week_end_date', 'weeks_in_top3'].sort(),
    );
    const meta = Object.values(getTableColumns(keywordTopAsinsMeta)).map((c) => c.name).sort();
    expect(meta).toEqual(['built_at', 'row_count', 'singleton', 'week_end_date'].sort());
  });
  it('adds rank_ratio_x100 to the catalog', () => {
    expect(getTableColumns(asinProducts).rankRatioX100.name).toBe('rank_ratio_x100');
  });
});
