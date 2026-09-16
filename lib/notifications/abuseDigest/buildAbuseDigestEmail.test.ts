import { describe, expect, it } from 'vitest';
import {
  buildAbuseDigestEmail,
  ACTIVE_USER_ROW_CAP,
  SIGNUP_ROW_CAP,
  FLAG_ROW_CAP,
} from './buildAbuseDigestEmail';
import type { AbuseDigestStats, Flag, PerUserActivity } from './types';

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
  };
}

function activeUser(i: number, reads: number): PerUserActivity {
  return {
    userId: `u${i}`,
    email: `user${i}@x.com`,
    name: null,
    explorerQueries: reads,
    detailViews: 0,
    watchlistAdds: 0,
    savedViewsCreated: 0,
    customCategoriesCreated: 0,
    exports: 0,
  };
}

describe('buildAbuseDigestEmail', () => {
  it('quiet day: pulse subject with zeros, "all quiet" body, still a full email', () => {
    const built = buildAbuseDigestEmail(quietStats(), []);
    expect(built.subject).toBe('KeywordQuarry daily — 0 signups · 0 active · 0 reads');
    expect(built.html).toContain('All quiet');
    expect(built.text).toContain('All quiet');
    expect(built.html).toContain('2026-07-12');
  });

  it('normal day: subject carries signups/active/reads; body lists signups and activity', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      signups: [{ email: 'new@x.com', name: 'New Person', createdAt: '2026-07-12T15:30:00.000Z' }],
      activeUsers: [activeUser(1, 1200), activeUser(2, 34)],
      signIns: { count: 2, emails: ['user1@x.com', 'user2@x.com'] },
      contact: { submissions: 1, honeypotTrips: 3 },
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.subject).toBe('KeywordQuarry daily — 1 signup · 2 active · 1,234 reads');
    expect(built.html).toContain('new@x.com');
    expect(built.html).toContain('user1@x.com');
    expect(built.html).toContain('1,200');
    expect(built.text).toContain('new@x.com');
    expect(built.html).toContain('/admin');
  });

  it('flags prefix the subject and render before everything else', () => {
    const built = buildAbuseDigestEmail(quietStats(), [
      { severity: 'red', message: 'bad thing' },
      { severity: 'amber', message: 'warm thing' },
    ]);
    expect(built.subject).toBe('⚠️ 2 flags — KeywordQuarry daily — 0 signups · 0 active · 0 reads');
    expect(built.html.indexOf('bad thing')).toBeLessThan(built.html.indexOf('All quiet'));
    expect(built.text).toContain('bad thing');
  });

  it('uses singular "flag" for one flag', () => {
    const built = buildAbuseDigestEmail(quietStats(), [{ severity: 'amber', message: 'x' }]);
    expect(built.subject.startsWith('⚠️ 1 flag —')).toBe(true);
  });

  it(`caps the activity table at ${ACTIVE_USER_ROW_CAP} rows and says how many were dropped`, () => {
    const stats = {
      ...quietStats(),
      activeUsers: Array.from({ length: ACTIVE_USER_ROW_CAP + 3 }, (_, i) => activeUser(i, 100 - i)),
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).toContain(`user${ACTIVE_USER_ROW_CAP - 1}@x.com`);
    expect(built.html).not.toContain(`user${ACTIVE_USER_ROW_CAP}@x.com`);
    expect(built.html).toContain('and 3 more active users');
    expect(built.text).toContain(`user${ACTIVE_USER_ROW_CAP - 1}@x.com`);
    expect(built.text).not.toContain(`user${ACTIVE_USER_ROW_CAP}@x.com`);
    expect(built.text).toContain('and 3 more active users');
  });

  it(`caps rendered signups at ${SIGNUP_ROW_CAP} while headings keep the true count`, () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      signups: Array.from({ length: SIGNUP_ROW_CAP + 3 }, (_, i) => ({
        email: `s${i}@x.com`,
        name: null,
        createdAt: '2026-07-12T15:30:00.000Z',
      })),
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.subject).toContain('53 signups');
    expect(built.html).toContain(`Signups (${SIGNUP_ROW_CAP + 3})`);
    expect(built.html).toContain(`s${SIGNUP_ROW_CAP - 1}@x.com`);
    expect(built.html).not.toContain(`s${SIGNUP_ROW_CAP}@x.com`);
    expect(built.html).toContain('and 3 more signups');
    expect(built.text).toContain('and 3 more signups');
  });

  it(`caps rendered flags at ${FLAG_ROW_CAP} while the subject keeps the true count`, () => {
    const flags: Flag[] = Array.from({ length: FLAG_ROW_CAP + 2 }, (_, i) => ({
      severity: 'amber' as const,
      message: `flag number ${i}`,
    }));
    const built = buildAbuseDigestEmail(quietStats(), flags);
    expect(built.subject.startsWith(`⚠️ ${FLAG_ROW_CAP + 2} flags —`)).toBe(true);
    expect(built.html).toContain(`flag number ${FLAG_ROW_CAP - 1}`);
    expect(built.html).not.toContain(`flag number ${FLAG_ROW_CAP}`);
    expect(built.html).toContain('and 2 more flags');
    expect(built.text).toContain('and 2 more flags');
  });

  it('escapes HTML in user-controlled fields', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      signups: [{ email: 'x@x.com', name: '<script>alert(1)</script>', createdAt: '2026-07-12T15:30:00.000Z' }],
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).not.toContain('<script>');
    expect(built.html).toContain('&lt;script&gt;');
  });
});

describe('buildAbuseDigestEmail — active-user windows', () => {
  function withWindows(): AbuseDigestStats {
    return {
      ...quietStats(),
      activeUsers: [activeUser(1, 1200)],
      weeklyActiveUsers: {
        startDay: '2026-07-06',
        endDay: '2026-07-12',
        users: [activeUser(1, 4000), activeUser(2, 300), activeUser(3, 12)],
      },
      monthlyActiveUsers: {
        startDay: '2026-06-13',
        endDay: '2026-07-12',
        users: [1, 2, 3, 4, 5].map((i) => activeUser(i, 100 * i)),
      },
    };
  }

  it('renders daily, weekly, and monthly sections with counts and date ranges', () => {
    const built = buildAbuseDigestEmail(withWindows(), []);
    expect(built.html).toContain('Daily active users (1)');
    expect(built.html).toContain('Weekly active users (3)');
    expect(built.html).toContain('Monthly active users (5)');
    expect(built.html).toContain('Jul 6 – Jul 12');
    expect(built.html).toContain('Jun 13 – Jul 12');
    expect(built.html).toContain('4,000');
    expect(built.text).toContain('Daily active users (1)');
    expect(built.text).toContain('Weekly active users (3)');
    expect(built.text).toContain('Monthly active users (5)');
    expect(built.html).not.toContain('>Active users (');
  });

  it('keeps the subject line unchanged (no weekly/monthly counts)', () => {
    const built = buildAbuseDigestEmail(withWindows(), []);
    expect(built.subject).toBe('KeywordQuarry daily — 0 signups · 1 active · 1,200 reads');
  });

  it('still renders the weekly and monthly tables on a quiet day', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      weeklyActiveUsers: { startDay: '2026-07-06', endDay: '2026-07-12', users: [activeUser(7, 50)] },
      monthlyActiveUsers: { startDay: '2026-06-13', endDay: '2026-07-12', users: [activeUser(7, 50)] },
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).toContain('All quiet');
    expect(built.html).toContain('Weekly active users (1)');
    expect(built.html).toContain('user7@x.com');
    expect(built.text).toContain('Monthly active users (1)');
  });

  it('says so when a window has no activity', () => {
    const built = buildAbuseDigestEmail(quietStats(), []);
    expect(built.html).toContain('Weekly active users (0)');
    expect(built.html).toContain('No user activity in this window.');
  });

  it(`caps each window table at ${ACTIVE_USER_ROW_CAP} rows`, () => {
    const many = Array.from({ length: ACTIVE_USER_ROW_CAP + 3 }, (_, i) => activeUser(i, 10));
    const stats: AbuseDigestStats = {
      ...quietStats(),
      weeklyActiveUsers: { startDay: '2026-07-06', endDay: '2026-07-12', users: many },
      monthlyActiveUsers: { startDay: '2026-06-13', endDay: '2026-07-12', users: many },
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html.match(/…and 3 more active users/g)).toHaveLength(2);
  });
});

describe('buildAbuseDigestEmail — exports column', () => {
  it('renders an Exports column in the tables and the count in the text rows', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      activeUsers: [{ ...activeUser(1, 50), exports: 3 }],
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).toContain('>Exports</th>');
    expect(built.html).toContain('<td style="padding:5px 0 5px 8px;text-align:right;">3</td>');
    expect(built.text).toContain('0 categories, 3 exports');
  });
});

