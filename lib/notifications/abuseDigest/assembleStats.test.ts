import { describe, expect, it } from 'vitest';
import { assemblePerUserActivity, type CounterRow, type CreationCounts, type UserInfo } from './assembleStats';

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';
const U3 = '00000000-0000-0000-0000-000000000003';

const info = new Map<string, UserInfo>([
  [U1, { email: 'a@x.com', name: 'A' }],
  [U2, { email: 'b@x.com', name: null }],
  [U3, { email: 'c@x.com', name: 'C' }],
]);

describe('assemblePerUserActivity', () => {
  it('merges counters and creations into one row per user, sorted by reads desc', () => {
    const counters: CounterRow[] = [
      { userId: U1, metric: 'explorer_query', count: 5 },
      { userId: U1, metric: 'detail_view', count: 2 },
      { userId: U2, metric: 'explorer_query', count: 100 },
    ];
    const creations: CreationCounts = {
      watchlistAdds: new Map([[U1, 3]]),
      savedViewsCreated: new Map(),
      customCategoriesCreated: new Map([[U3, 1]]),
    };

    const rows = assemblePerUserActivity(counters, creations, info);

    expect(rows.map((r) => r.userId)).toEqual([U2, U1, U3]); // 100 reads, 7 reads, 0 reads
    expect(rows[1]).toEqual({
      userId: U1,
      email: 'a@x.com',
      name: 'A',
      explorerQueries: 5,
      detailViews: 2,
      watchlistAdds: 3,
      savedViewsCreated: 0,
      customCategoriesCreated: 0,
    });
    // A creations-only user (no counters) still appears as active:
    expect(rows[2].customCategoriesCreated).toBe(1);
    expect(rows[2].explorerQueries).toBe(0);
  });

  it('ignores unknown metrics defensively', () => {
    const counters = [{ userId: U1, metric: 'future_metric', count: 9 }] as CounterRow[];
    const rows = assemblePerUserActivity(
      counters,
      { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
      info,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].explorerQueries).toBe(0);
    expect(rows[0].detailViews).toBe(0);
  });

  it('falls back to placeholder identity when the users row is missing', () => {
    const counters: CounterRow[] = [{ userId: U1, metric: 'explorer_query', count: 1 }];
    const rows = assemblePerUserActivity(
      counters,
      { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
      new Map(),
    );
    expect(rows[0].email).toBe('(unknown user)');
    expect(rows[0].name).toBeNull();
  });

  it('returns [] when nothing happened', () => {
    expect(
      assemblePerUserActivity(
        [],
        { watchlistAdds: new Map(), savedViewsCreated: new Map(), customCategoriesCreated: new Map() },
        info,
      ),
    ).toEqual([]);
  });
});
