import { describe, expect, it } from 'vitest';
import { evaluateFlags, THRESHOLDS } from './evaluateFlags';
import type { AbuseDigestStats, PerUserActivity } from './types';

function quietStats(): AbuseDigestStats {
  return {
    day: '2026-07-12',
    totalUsers: 2,
    signups: [],
    activeUsers: [],
    weeklyActiveUsers: { startDay: '2026-07-06', endDay: '2026-07-12', users: [] },
    monthlyActiveUsers: { startDay: '2026-06-13', endDay: '2026-07-12', users: [] },
    signIns: { count: 0, emails: [] },
    contact: { submissions: 0, honeypotTrips: 0 },
    slowSearches: { timeouts: 0, slow: 0, top: [] },
  };
}

function userWith(overrides: Partial<PerUserActivity>): PerUserActivity {
  return {
    userId: 'u1',
    email: 'a@x.com',
    name: null,
    explorerQueries: 0,
    detailViews: 0,
    watchlistAdds: 0,
    savedViewsCreated: 0,
    customCategoriesCreated: 0,
    exports: 0,
    mcpRequests: 0,
    mcpRows: 0,
    mcpWrites: 0,
    productsQueries: 0,
    productViews: 0,
    ...overrides,
  };
}

function signup(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    email: `s${i}@x.com`,
    name: null,
    createdAt: '2026-07-12T12:00:00.000Z',
  }));
}

describe('evaluateFlags', () => {
  it('returns no flags on a quiet day', () => {
    expect(evaluateFlags(quietStats())).toEqual([]);
  });

  it('does not flag AT a threshold (strictly greater-than)', () => {
    const stats = { ...quietStats(), signups: signup(10) };
    expect(evaluateFlags(stats)).toEqual([]);
  });

  it('flags signups amber above 10 and red above 25 (one flag, red supersedes)', () => {
    expect(evaluateFlags({ ...quietStats(), signups: signup(11) })).toEqual([
      { severity: 'amber', message: '11 signups yesterday (amber threshold: 10)' },
    ]);
    const red = evaluateFlags({ ...quietStats(), signups: signup(26) });
    expect(red).toEqual([{ severity: 'red', message: '26 signups yesterday (red threshold: 25)' }]);
  });

  it('flags per-user reads (queries + detail views combined)', () => {
    const amber = evaluateFlags({
      ...quietStats(),
      activeUsers: [userWith({ explorerQueries: 400, detailViews: 101 })],
    });
    expect(amber).toEqual([
      { severity: 'amber', message: 'a@x.com: 501 reads (amber threshold: 500)' },
    ]);
    const red = evaluateFlags({
      ...quietStats(),
      activeUsers: [userWith({ explorerQueries: 2001 })],
    });
    expect(red[0].severity).toBe('red');
  });

  it('flags per-user creations', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      activeUsers: [
        userWith({ watchlistAdds: 51, savedViewsCreated: 5, customCategoriesCreated: 11 }),
      ],
    });
    expect(flags).toEqual([
      { severity: 'amber', message: 'a@x.com: 51 watchlist adds (amber threshold: 50)' },
      { severity: 'amber', message: 'a@x.com: 5 saved views created (amber threshold: 4)' },
      { severity: 'amber', message: 'a@x.com: 11 custom categories created (amber threshold: 10)' },
    ]);
  });

  it('flags multiple users independently', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      activeUsers: [
        userWith({ userId: 'u1', email: 'a@x.com', explorerQueries: 600 }),
        userWith({ userId: 'u2', email: 'b@x.com', savedViewsCreated: 5 }),
      ],
    });
    expect(flags).toEqual([
      { severity: 'amber', message: 'a@x.com: 600 reads (amber threshold: 500)' },
      { severity: 'amber', message: 'b@x.com: 5 saved views created (amber threshold: 4)' },
    ]);
  });

  it('every red threshold sits above its amber sibling', () => {
    for (const t of Object.values(THRESHOLDS)) {
      if ('red' in t) expect(t.red).toBeGreaterThan(t.amber);
    }
  });

  it('flags contact-form pressure', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      contact: { submissions: 11, honeypotTrips: 21 },
    });
    expect(flags).toEqual([
      { severity: 'amber', message: '21 honeypot trips yesterday (amber threshold: 20)' },
      { severity: 'amber', message: '11 contact submissions yesterday (amber threshold: 10)' },
    ]);
  });

  it('sorts red flags before amber', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      signups: signup(11), // amber
      activeUsers: [userWith({ explorerQueries: 3000 })], // red
    });
    expect(flags.map((f) => f.severity)).toEqual(['red', 'amber']);
  });

  it('flags more than 100 MCP writes in a day as amber (spec 2026-09-30 §8.4)', () => {
    const stats = { ...quietStats(), activeUsers: [userWith({ mcpWrites: 101 })] };
    expect(evaluateFlags(stats)).toEqual([{ severity: 'amber', message: 'a@x.com: 101 MCP writes (amber threshold: 100)' }]);
    expect(evaluateFlags({ ...quietStats(), activeUsers: [userWith({ mcpWrites: 100 })] })).toEqual([]);
    expect(THRESHOLDS.userMcpWritesPerDay).toEqual({ amber: 100 });
  });
});

describe('evaluateFlags — Products (spec 2026-10-23 §4, §5b)', () => {
  it('counts product searches and product views in the per-user reads, on the same 500 / 2000 bands', () => {
    expect(THRESHOLDS.userReadsPerDay).toEqual({ amber: 500, red: 2000 });
    const amber = evaluateFlags({
      ...quietStats(),
      activeUsers: [userWith({ explorerQueries: 200, detailViews: 100, productsQueries: 150, productViews: 51 })],
    });
    expect(amber).toEqual([{ severity: 'amber', message: 'a@x.com: 501 reads (amber threshold: 500)' }]);
    const red = evaluateFlags({ ...quietStats(), activeUsers: [userWith({ productsQueries: 1500, productViews: 501 })] });
    expect(red).toEqual([{ severity: 'red', message: 'a@x.com: 2001 reads (red threshold: 2000)' }]);
    // At the threshold: no flag (strictly greater-than), products alone included.
    expect(evaluateFlags({ ...quietStats(), activeUsers: [userWith({ productsQueries: 250, productViews: 250 })] })).toEqual([]);
  });

  it('flags any product search timeout amber (threshold 0), singular at 1; slow searches alone never flag', () => {
    expect(THRESHOLDS.productSearchTimeoutsPerDay).toEqual({ amber: 0 });
    const top = [{ queryString: 'broad=Home&sort=keywords', occurrences: 3, accounts: 2 }];
    expect(evaluateFlags({ ...quietStats(), slowSearches: { timeouts: 3, slow: 0, top } })).toEqual([
      { severity: 'amber', message: '3 product search timeouts yesterday (amber threshold: 0)' },
    ]);
    expect(evaluateFlags({ ...quietStats(), slowSearches: { timeouts: 1, slow: 4, top } })).toEqual([
      { severity: 'amber', message: '1 product search timeout yesterday (amber threshold: 0)' },
    ]);
    expect(evaluateFlags({ ...quietStats(), slowSearches: { timeouts: 0, slow: 12, top } })).toEqual([]);
  });

  it('a timeout flag sorts after a red flag like any amber one', () => {
    const flags = evaluateFlags({
      ...quietStats(),
      activeUsers: [userWith({ productViews: 2500 })],
      slowSearches: { timeouts: 2, slow: 1, top: [] },
    });
    expect(flags).toEqual([
      { severity: 'red', message: 'a@x.com: 2500 reads (red threshold: 2000)' },
      { severity: 'amber', message: '2 product search timeouts yesterday (amber threshold: 0)' },
    ]);
  });
});
