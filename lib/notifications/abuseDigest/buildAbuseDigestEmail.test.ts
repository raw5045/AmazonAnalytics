import { describe, expect, it } from 'vitest';
import {
  buildAbuseDigestEmail,
  ACTIVE_USER_ROW_CAP,
  SIGNUP_ROW_CAP,
  FLAG_ROW_CAP,
  SLOW_SEARCH_ROW_CAP,
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
    slowSearches: { timeouts: 0, slow: 0, top: [] },
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
    mcpRequests: 0,
    mcpRows: 0,
    mcpWrites: 0,
    productsQueries: 0,
    productViews: 0,
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

describe('buildAbuseDigestEmail — MCP columns', () => {
  it('renders MCP calls/rows columns in the table and the counts in the text rows', () => {
    const stats: AbuseDigestStats = {
      ...quietStats(),
      activeUsers: [{ ...activeUser(1, 50), mcpRequests: 12, mcpRows: 480 }],
    };
    const built = buildAbuseDigestEmail(stats, []);
    expect(built.html).toContain('>MCP calls</th>');
    expect(built.html).toContain('>MCP rows</th>');
    expect(built.html).toContain('<td style="padding:5px 0 5px 8px;text-align:right;">12</td>');
    expect(built.html).toContain('<td style="padding:5px 0 5px 8px;text-align:right;">480</td>');
    expect(built.text).toContain('12 MCP calls (480 rows)');
    // Column order is pinned: Exports, then MCP calls, then MCP rows (headers and cells alike).
    const calls = built.html.indexOf('>MCP calls</th>');
    expect(calls).toBeGreaterThan(built.html.indexOf('>Exports</th>'));
    expect(built.html.indexOf('>MCP rows</th>')).toBeGreaterThan(calls);
    expect(built.html.indexOf('>12</td>')).toBeLessThan(built.html.indexOf('>480</td>'));
  });

  it('shows MCP writes next to MCP calls in both the text and the HTML table', () => {
    const stats = { ...quietStats(), activeUsers: [{ ...activeUser(1, 3), mcpRequests: 5, mcpRows: 250, mcpWrites: 2 }] };
    const { text, html } = buildAbuseDigestEmail(stats, []);
    expect(text).toContain('5 MCP calls (250 rows), 2 MCP writes');
    expect(html).toContain('<th style="padding:5px 0 5px 8px;text-align:right;">MCP writes</th>');
    expect(html.indexOf('>MCP writes</th>')).toBeGreaterThan(html.indexOf('>MCP rows</th>'));
    expect(html).toMatch(/<td[^>]*>2<\/td>\s*<\/tr>/);
  });
});

describe('buildAbuseDigestEmail — Products columns (spec 2026-10-23 §4)', () => {
  /** 12 queries, 3 detail views, 7 product searches, 5 product views; every other counter 0. */
  const productsUser = (i: number): PerUserActivity => ({ ...activeUser(i, 12), detailViews: 3, productsQueries: 7, productViews: 5 });
  /** The same user in all three per-user tables: daily, weekly, monthly. */
  function everyTable(): AbuseDigestStats {
    return {
      ...quietStats(),
      activeUsers: [productsUser(1)],
      weeklyActiveUsers: { startDay: '2026-07-06', endDay: '2026-07-12', users: [productsUser(1)] },
      monthlyActiveUsers: { startDay: '2026-06-13', endDay: '2026-07-12', users: [productsUser(1)] },
    };
  }

  it('puts "Products" and "Product views" right after "Detail views" in every per-user table, headers and cells alike', () => {
    const { html } = buildAbuseDigestEmail(everyTable(), []);
    const headers = [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    const one = ['User', 'Queries', 'Detail views', 'Products', 'Product views', 'Watchlist adds', 'Saved views', 'Categories', 'Exports', 'MCP calls', 'MCP rows', 'MCP writes'];
    expect(headers).toEqual([...one, ...one, ...one]); // daily, weekly, monthly
    const rows = [...html.matchAll(/<tr style="border-bottom:1px solid #f3f4f6;">([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1]),
    );
    expect(rows).toHaveLength(3);
    for (const cells of rows) expect(cells).toEqual(['user1@x.com', '12', '3', '7', '5', '0', '0', '0', '0', '0', '0', '0']);
  });

  it('carries both counts right after the detail views in every text row', () => {
    const { text } = buildAbuseDigestEmail(everyTable(), []);
    const line =
      'user1@x.com: 12 queries, 3 detail views, 7 product searches, 5 product views, 0 watchlist adds, 0 views, 0 categories, 0 exports, ' +
      '0 MCP calls (0 rows), 0 MCP writes';
    expect(text.split('\n').filter((l) => l.trim() === line)).toHaveLength(3);
  });

  it("counts them in the subject's reads pulse", () => {
    const stats: AbuseDigestStats = { ...quietStats(), activeUsers: [productsUser(1), { ...activeUser(2, 0), productViews: 1_000 }] };
    // (12 + 3 + 7 + 5) + 1,000
    expect(buildAbuseDigestEmail(stats, []).subject).toBe('KeywordQuarry daily — 0 signups · 2 active · 1,027 reads');
  });
});

describe('buildAbuseDigestEmail — slow product searches (spec 2026-10-23 §5b)', () => {
  /** Every occurrence from the Products list (viaTool 0); the tool's marker has its own case below. */
  const TOP = [
    { queryString: 'broad=Home&sort=keywords', occurrences: 3, accounts: 2, viaTool: 0 },
    { queryString: 'age=60', occurrences: 1, accounts: 1, viaTool: 0 },
  ];
  const withSlow = (slowSearches: AbuseDigestStats['slowSearches']): AbuseDigestStats => ({ ...quietStats(), activeUsers: [activeUser(1, 5)], slowSearches });
  /** The text rows under the section heading, up to the next blank line. */
  function sectionLines(text: string, heading: string): string[] {
    const lines = text.split('\n');
    const at = lines.indexOf(heading);
    expect(at).toBeGreaterThan(-1);
    const end = lines.indexOf('', at);
    return lines.slice(at + 1, end === -1 ? undefined : end);
  }

  it('text: the heading with both counts, then one "N× by M account(s): <query string>" row per query', () => {
    const { text } = buildAbuseDigestEmail(withSlow({ timeouts: 2, slow: 5, top: TOP }), []);
    expect(sectionLines(text, 'Slow product searches (timeouts 2, slow 5):')).toEqual([
      '  3× by 2 account(s): broad=Home&sort=keywords',
      '  1× by 1 account(s): age=60',
    ]);
  });

  it('html: the heading, then the rows as a monospace list, each query string escaped', () => {
    const { html } = buildAbuseDigestEmail(withSlow({ timeouts: 2, slow: 5, top: TOP }), []);
    expect(html).toContain('>Slow product searches (timeouts 2, slow 5)</h2>');
    expect(html).toMatch(/>Slow product searches \(timeouts 2, slow 5\)<\/h2>\s*<ul style="[^"]*font-family:[^"]*monospace[^"]*">/);
    expect(html).toContain('<li>3× by 2 account(s): broad=Home&amp;sort=keywords</li><li>1× by 1 account(s): age=60</li>');
  });

  it('marks the occurrences from AI tools (the search_products tool) after the accounts, only on rows that have any, in both bodies', () => {
    const top = [
      { queryString: 'broad=Home&sort=keywords', occurrences: 3, accounts: 2, viaTool: 1 },
      { queryString: 'dept=Pet+Supplies&sort=price', occurrences: 2, accounts: 1, viaTool: 2 },
      { queryString: 'age=60', occurrences: 1, accounts: 1, viaTool: 0 },
    ];
    const { text, html } = buildAbuseDigestEmail(withSlow({ timeouts: 2, slow: 4, top }), []);
    expect(sectionLines(text, 'Slow product searches (timeouts 2, slow 4):')).toEqual([
      '  3× by 2 account(s), 1 via AI tools: broad=Home&sort=keywords',
      '  2× by 1 account(s), 2 via AI tools: dept=Pet+Supplies&sort=price',
      '  1× by 1 account(s): age=60',
    ]);
    expect(html).toContain(
      '<li>3× by 2 account(s), 1 via AI tools: broad=Home&amp;sort=keywords</li><li>2× by 1 account(s), 2 via AI tools: dept=Pet+Supplies&amp;sort=price</li><li>1× by 1 account(s): age=60</li>',
    );
  });

  it('sits after the daily active users and before the weekly and monthly sections, in both bodies', () => {
    const { text, html } = buildAbuseDigestEmail(withSlow({ timeouts: 0, slow: 1, top: TOP.slice(1) }), []);
    for (const body of [text, html]) {
      const daily = body.indexOf('Daily active users (1)');
      const slow = body.indexOf('Slow product searches (timeouts 0, slow 1)');
      expect(daily).toBeGreaterThan(-1);
      expect(slow).toBeGreaterThan(daily);
      expect(body.indexOf('Weekly active users (0)')).toBeGreaterThan(slow);
      expect(body.indexOf('Monthly active users (0)')).toBeGreaterThan(slow);
    }
  });

  it('says "none" when there were no rows, and renders on a quiet day too', () => {
    const { text, html } = buildAbuseDigestEmail(quietStats(), []);
    expect(text).toContain('All quiet');
    expect(sectionLines(text, 'Slow product searches (timeouts 0, slow 0):')).toEqual(['  none']);
    expect(html).toMatch(/>Slow product searches \(timeouts 0, slow 0\)<\/h2>\s*<p[^>]*>none<\/p>/);
    expect(html).not.toContain('account(s):');
  });

  it('escapes HTML in a query string', () => {
    const { html } = buildAbuseDigestEmail(
      withSlow({ timeouts: 1, slow: 0, top: [{ queryString: `q=<script>alert(1)</script>&x="1'`, occurrences: 1, accounts: 1, viaTool: 0 }] }),
      [],
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('<li>1× by 1 account(s): q=&lt;script&gt;alert(1)&lt;/script&gt;&amp;x=&quot;1&#39;</li>');
  });

  it('truncates a query string longer than 400 characters for display, with a "… (+N chars)" marker, in both bodies', () => {
    const long = `custom=${'a'.repeat(593)}`; // 600 characters
    const exact = `q=${'b'.repeat(398)}`; // 400 characters: shown whole
    expect([long.length, exact.length]).toEqual([600, 400]);
    const { text, html } = buildAbuseDigestEmail(
      withSlow({ timeouts: 0, slow: 2, top: [{ queryString: long, occurrences: 1, accounts: 1, viaTool: 0 }, { queryString: exact, occurrences: 1, accounts: 1, viaTool: 0 }] }),
      [],
    );
    const shown = `${long.slice(0, 400)}… (+200 chars)`;
    expect(sectionLines(text, 'Slow product searches (timeouts 0, slow 2):')).toEqual([`  1× by 1 account(s): ${shown}`, `  1× by 1 account(s): ${exact}`]);
    expect(html).toContain(`<li>1× by 1 account(s): ${shown}</li><li>1× by 1 account(s): ${exact}</li>`);
    expect(text).not.toContain(long);
    expect(html).not.toContain(long);
  });

  it('truncates before escaping: the marker counts stored characters and no entity is cut in half', () => {
    const { html } = buildAbuseDigestEmail(withSlow({ timeouts: 1, slow: 0, top: [{ queryString: '&'.repeat(450), occurrences: 1, accounts: 1, viaTool: 0 }] }), []);
    expect(html).toContain(`<li>1× by 1 account(s): ${'&amp;'.repeat(400)}… (+50 chars)</li>`);
  });

  it('an empty query string (the default list) reads "(no filters)"', () => {
    const { text, html } = buildAbuseDigestEmail(withSlow({ timeouts: 1, slow: 0, top: [{ queryString: '', occurrences: 2, accounts: 1, viaTool: 0 }] }), []);
    expect(sectionLines(text, 'Slow product searches (timeouts 1, slow 0):')).toEqual(['  2× by 1 account(s): (no filters)']);
    expect(html).toContain('<li>2× by 1 account(s): (no filters)</li>');
  });

  it(`shows at most ${SLOW_SEARCH_ROW_CAP} rows; the heading keeps the true counts`, () => {
    expect(SLOW_SEARCH_ROW_CAP).toBe(10);
    const top = Array.from({ length: SLOW_SEARCH_ROW_CAP + 2 }, (_, i) => ({ queryString: `sort=price&page=${i + 1}`, occurrences: 20 - i, accounts: 1, viaTool: 0 }));
    const { text, html } = buildAbuseDigestEmail(withSlow({ timeouts: 4, slow: 30, top }), []);
    const rows = sectionLines(text, 'Slow product searches (timeouts 4, slow 30):');
    expect(rows).toHaveLength(SLOW_SEARCH_ROW_CAP);
    expect(rows[SLOW_SEARCH_ROW_CAP - 1]).toBe('  11× by 1 account(s): sort=price&page=10');
    expect(html.match(/account\(s\): /g)).toHaveLength(SLOW_SEARCH_ROW_CAP);
    expect(html).not.toContain('page=11');
  });
});

