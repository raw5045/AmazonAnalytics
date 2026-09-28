/**
 * Synthetic test-user emails.
 *
 * Integration tests run against the PRODUCTION database and create users
 * named `<prefix>_<epoch>@...` (see tests/integration/helpers.ts). This is the
 * single source of truth for that shape, shared by:
 *   - the integration harness (createTestUser's tripwire, the orphan sweep),
 *   - production code that must never treat such a row as a real member
 *     (the Resend contact sync in lib/notifications/resendContacts.ts).
 *
 * Anchored at the start and requiring `<prefix>_<digits>@`, so a real address is
 * very unlikely to match but not impossible (any digit run counts: `rw_1990@…`
 * would). The integration sweep has relied on this shape since 2026-09-16;
 * tightening the digit run (`[0-9]{10,}` — every harness epoch is 13 digits) is a
 * possible follow-up, not a given. Case-sensitive on purpose: the
 * harness writes lowercase prefixes and Postgres `~` is case-sensitive, so the
 * JS check and the SQL sweep agree. A test that invents a new prefix must add
 * it here, or its rows would be unsweepable (createTestUser tripwires on it).
 */
export const TEST_USER_PREFIXES = ['integration', 'itest', 'rw', 'csmtest'] as const;
export type TestUserPrefix = (typeof TEST_USER_PREFIXES)[number];

/**
 * Postgres regex (for the `~` operator); `isSyntheticTestEmail` is its JS twin.
 * Keep it backslash-free and within syntax JS and Postgres read alike ([0-9], never \d).
 */
export const TEST_USER_EMAIL_SQL_PATTERN = `^(${TEST_USER_PREFIXES.join('|')})_[0-9]+@`;
const TEST_USER_EMAIL_REGEX = new RegExp(TEST_USER_EMAIL_SQL_PATTERN);

export function isSyntheticTestEmail(email: string): boolean {
  return TEST_USER_EMAIL_REGEX.test(email);
}
