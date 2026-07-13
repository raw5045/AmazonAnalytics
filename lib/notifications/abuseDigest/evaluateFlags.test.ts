import { describe, expect, it } from 'vitest';
import { evaluateFlags, THRESHOLDS } from './evaluateFlags';
import type { AbuseDigestStats, PerUserActivity } from './types';

function quietStats(): AbuseDigestStats {
  return {
    day: '2026-07-12',
    totalUsers: 2,
    signups: [],
    activeUsers: [],
    signIns: { count: 0, emails: [] },
    contact: { submissions: 0, honeypotTrips: 0 },
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
});
