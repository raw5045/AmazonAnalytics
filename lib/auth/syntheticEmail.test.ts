import { describe, it, expect } from 'vitest';
import {
  TEST_USER_EMAIL_SQL_PATTERN,
  TEST_USER_PREFIXES,
  isSyntheticTestEmail,
} from './syntheticEmail';

describe('isSyntheticTestEmail', () => {
  it.each([
    'integration_1700000000000@example.com',
    'itest_1@example.com',
    'rw_42@x.com',
    'csmtest_7@example.org',
  ])('matches the harness shape %s', (email) => {
    expect(isSyntheticTestEmail(email)).toBe(true);
  });

  it.each([
    'jane@shop.co',
    'itest_abc@example.com', // no numeric epoch
    'myitest_1@example.com', // prefix not at the start
    'itest_@example.com', // empty epoch
    'itest_1example.com', // no @ after the epoch
    'ITEST_1@example.com', // case-sensitive, like the SQL sweep
    'itests_1@x.com', // the "_" must follow the prefix directly
    'rw-1@x.com', // "-" is not "_"
    'itest_1a@x.com', // the digits must run straight into "@"
  ])('rejects %s', (email) => {
    expect(isSyntheticTestEmail(email)).toBe(false);
  });

  // The string below is what sweepOrphanTestUsers passes to Postgres `~` to DELETE rows.
  // Keep it free of backslashes and within syntax both engines read the same way
  // ([0-9], not \d: Postgres \d is locale-dependent, JS \d is ASCII-only).
  it('pins the exact Postgres pattern the production orphan sweep runs', () => {
    expect(TEST_USER_PREFIXES).toEqual(['integration', 'itest', 'rw', 'csmtest']);
    expect(TEST_USER_EMAIL_SQL_PATTERN).toBe('^(integration|itest|rw|csmtest)_[0-9]+@');
  });
});
