// lib/notifications/digest/loadDigestData.test.ts
import { describe, it, expect, vi } from 'vitest';

// The module imports the real db client once the loaders land (Task 3.2).
// We only test the pure transform here, so stub the client to a no-op so
// importing the module never opens a Neon connection. (Same spirit as
// bulkAdd.test.ts mocking @/db/client.)
vi.mock('@/db/client', () => ({ db: {} }));

import { groupAndSortWatchlistRows, type RawWatchlistRow } from './loadDigestData';

const raw = (over: Partial<RawWatchlistRow>): RawWatchlistRow => ({
  userId: 'u1',
  searchTermId: 'k1',
  searchTermRaw: 'kw',
  currentRank: 100,
  priorWeekRank: 120,
  rank4wAgo: 130,
  improvement1w: 20,
  estMonthlyVolume: 5000,
  ...over,
});

describe('groupAndSortWatchlistRows', () => {
  it('groups rows by user', () => {
    const out = groupAndSortWatchlistRows([
      raw({ userId: 'u1', searchTermId: 'a' }),
      raw({ userId: 'u2', searchTermId: 'b' }),
      raw({ userId: 'u1', searchTermId: 'c' }),
    ]);
    expect(out.get('u1')?.map((r) => r.searchTermId).sort()).toEqual(['a', 'c']);
    expect(out.get('u2')?.map((r) => r.searchTermId)).toEqual(['b']);
  });

  it('sorts each user by absolute improvement, biggest first', () => {
    const out = groupAndSortWatchlistRows([
      raw({ userId: 'u1', searchTermId: 'small', improvement1w: 10 }),
      raw({ userId: 'u1', searchTermId: 'bigdrop', improvement1w: -900 }),
      raw({ userId: 'u1', searchTermId: 'biggain', improvement1w: 500 }),
    ]);
    expect(out.get('u1')?.map((r) => r.searchTermId)).toEqual(['bigdrop', 'biggain', 'small']);
  });

  it('puts null improvement (not-ranked / no-prior) last', () => {
    const out = groupAndSortWatchlistRows([
      raw({ userId: 'u1', searchTermId: 'nullimp', improvement1w: null }),
      raw({ userId: 'u1', searchTermId: 'mover', improvement1w: 50 }),
    ]);
    expect(out.get('u1')?.map((r) => r.searchTermId)).toEqual(['mover', 'nullimp']);
  });

  it('breaks ties by current rank ascending', () => {
    const out = groupAndSortWatchlistRows([
      raw({ userId: 'u1', searchTermId: 'worse', improvement1w: 100, currentRank: 9000 }),
      raw({ userId: 'u1', searchTermId: 'better', improvement1w: 100, currentRank: 50 }),
    ]);
    expect(out.get('u1')?.map((r) => r.searchTermId)).toEqual(['better', 'worse']);
  });

  it('maps raw fields to DigestKeywordRow shape', () => {
    const out = groupAndSortWatchlistRows([raw({ userId: 'u1', searchTermId: 'k', searchTermRaw: 'hello' })]);
    expect(out.get('u1')?.[0]).toEqual({
      searchTermId: 'k',
      searchTermRaw: 'hello',
      currentRank: 100,
      priorWeekRank: 120,
      rank4wAgo: 130,
      improvement1w: 20,
      estMonthlyVolume: 5000,
    });
  });
});
