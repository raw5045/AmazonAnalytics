# Resend Contact Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new member becomes a contact in the KeywordQuarry Resend segment automatically, and a deleted account's contact is removed, so a broadcast never again depends on a hand-exported CSV.

**Architecture:** A new fail-soft helper (`lib/notifications/resendContacts.ts`) wraps the Resend SDK's account-level Contacts API: `addResendContact` creates the contact inside the segment named by a new `RESEND_SEGMENT_ID` env var (Resend renamed Audiences to Segments; the SDK's `audiences` is deprecated), `removeResendContact` deletes the contact by email. `provisionUser` — the one place both provisioning paths meet (Clerk `user.created`/`user.updated` webhook, and `getCurrentUser`'s on-demand path) — runs the add exactly once per member, gated by the atomic upsert's `created` flag that already gates the welcome email, and with the same inline-vs-`after()` scheduling. The Clerk `user.deleted` branch deletes the row `RETURNING email` and removes that contact. The env var is the feature switch: unset means every call is a silent no-op. Design agreed with the owner in chat on 2026-09-28.

**Tech Stack:** Next.js 16 App Router (route handler + `after()` from `next/server`), TypeScript, Drizzle (`.returning()`), `resend` 6.12.3 (`contacts.create` / `contacts.remove`), Vitest 4 with hoisted `vi.mock` and `vi.stubEnv`.

---

## Design decisions (owner, 2026-09-28; verified against the installed SDK and Resend's docs)

| Decision | Choice |
|---|---|
| When | Exactly once per member, on the first creation of their `users` row, from whichever path inserts it (webhook or on-demand). `created` from the atomic upsert is the gate — the same one the welcome email uses — so Svix retries, `user.updated` events and the losing racer never add twice. |
| Where in Resend | Resend's current model is **Global Contacts** grouped into **Segments** (formerly Audiences; `resend.audiences` is a deprecated alias of `resend.segments`). The contact is created account-level with `segments: [{ id: RESEND_SEGMENT_ID }]`, which the SDK sends to `POST /contacts`. |
| What is sent | `email`; `firstName` = first whitespace-separated token of `users.name`; `lastName` = the remaining tokens (omitted when there are none). Nothing else — no `unsubscribed`, no properties. |
| Feature switch | `RESEND_SEGMENT_ID` unset (or empty) → silent no-op everywhere (local dev, unit tests, preview). Set but `RESEND_API_KEY` missing → one `console.warn`, no-op. The owner sets the var in Vercel; it is an identifier, not a secret, but is never pasted in chat. |
| Who is skipped | Undeliverable addresses (`isUndeliverableEmail`: example.com & co) and the integration harness's synthetic users (`^(integration\|itest\|rw\|csmtest)_[0-9]+@`). The pattern moves out of `tests/integration/helpers.ts` into `lib/auth/syntheticEmail.ts` so production code can import it without depending on `tests/`. |
| Failure policy | Fail-soft by contract, like `sendWelcomeEmail` and `bumpUserActivity`: never throws, one attempt, logged. A create whose error message says "already exists" is benign (`'exists'`) — never keyed on the status alone, because Resend's `resource_locked` is a temporary 409 (Task 2 review); a remove answered `not_found`/404 is benign (`'missing'`). Anything else logs at error level and returns `'failed'`. `removeResendContact` refuses an address containing `/ ? # % \` — the SDK splices the email unencoded into the `DELETE /contacts/<email>` path, so those characters could redirect the delete — and logs it for manual removal (Task 2 review). |
| Scheduling | Webhook: awaited inline (the Vercel function may freeze after it responds). On-demand (`getCurrentUser`): scheduled with `after()` so the member's first page render never waits on Resend. Same as the welcome email; the option is renamed from `welcome` to `sideEffects` because it now governs both. |
| Deletion | On Clerk `user.deleted`: `DELETE … RETURNING email`, then remove that contact globally (all segments) — the account is gone. Fail-soft: a Resend failure is logged, never a 500 (the row is already deleted, so a Svix retry could not recover the email anyway). |
| Consent | Never synced in either direction. A Resend broadcast unsubscribe and `weekly_digest_subscribed` stay independent; the helper never sends `unsubscribed`. |
| Backfill | Not part of this change: the owner's manual CSV import (85 contacts, 2026-09-28) covers existing members. Members who sign up between that export and this deploy can be picked up by an untracked one-off script later, on the owner's go. |

## File map

| File | Responsibility in this change |
|---|---|
| `lib/auth/syntheticEmail.ts` (new) | `TEST_USER_PREFIXES`, `TEST_USER_EMAIL_SQL_PATTERN`, `isSyntheticTestEmail()` — single source of truth for the synthetic test-user email shape. |
| `tests/integration/helpers.ts` | Imports the pattern from the module above (re-exports it); `createTestUser`'s tripwire uses `isSyntheticTestEmail`. |
| `lib/notifications/resendContacts.ts` (new) | `addResendContact`, `removeResendContact`, `splitName`; env reads, skip rules, fail-soft logging. |
| `lib/env.ts`, `.env.example` | Declare and document `RESEND_SEGMENT_ID` (and, in the example file, the two existing Resend vars it sits beside). |
| `lib/auth/provisionUser.ts` | Runs welcome email + contact add together under the existing `created` gate; option renamed `sideEffects`. |
| `lib/auth/getCurrentUser.ts` | Passes `{ sideEffects: 'after' }`. |
| `app/api/webhooks/clerk/route.ts` | `user.deleted` deletes `RETURNING email` and removes the contact. |

## Conventions (same as arc 1 and the exclude-terms work)

- TDD: write the failing test, run it, implement, run it green, commit. Every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (exactly; verify with `git log -1 --format='%(trailers)'`).
- Local commits only. Pushes are owner-gated: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` first, then `git push origin main` only when the owner says so in chat (the Railway worker restarts on every push).
- No DDL. Nothing in this plan touches the database schema.
- `git add` only the named files; untracked throwaway scripts stay untracked.
- Read `node_modules/next/dist/docs/` before touching route code (Task 4 edits a route handler; `after()` semantics are in the `after` doc).
- Unit tests: `pnpm vitest run <file>` (jsdom, `tests/integration/**` excluded). Integration tests hit the PRODUCTION database with synthetic users only: `RUN_INTEGRATION=1 pnpm vitest run tests/integration/<file>` (Git Bash; `cross-env` is not on the PATH).
- Never put a real member's email, an API key or a segment id in a test, a commit message or chat.

---

### Task 1: Move the synthetic test-user email pattern into `lib/auth/syntheticEmail.ts`

**Files:**
- Create: `lib/auth/syntheticEmail.ts`
- Test: `lib/auth/syntheticEmail.test.ts`
- Modify: `tests/integration/helpers.ts` (the constants block at lines 30–49 and the tripwire in `createTestUser`)

Why: `lib/` must not import from `tests/`, and the Resend helper (Task 2) needs the same rule the orphan sweep uses. One definition, two importers.

- [ ] **Step 1: Write the failing test**

Create `lib/auth/syntheticEmail.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TEST_USER_EMAIL_SQL_PATTERN, TEST_USER_PREFIXES, isSyntheticTestEmail } from './syntheticEmail';

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
  ])('rejects %s', (email) => {
    expect(isSyntheticTestEmail(email)).toBe(false);
  });

  it('keeps the SQL sweep pattern and the prefix list in lockstep', () => {
    expect(TEST_USER_PREFIXES).toEqual(['integration', 'itest', 'rw', 'csmtest']);
    expect(TEST_USER_EMAIL_SQL_PATTERN).toBe('^(integration|itest|rw|csmtest)_[0-9]+@');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/auth/syntheticEmail.test.ts`
Expected: FAIL — cannot find module `./syntheticEmail`.

- [ ] **Step 3: Create the module**

Create `lib/auth/syntheticEmail.ts`:

```ts
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
 * Anchored at the start and requiring a numeric epoch + `@`, so it can never
 * match a real Clerk-provisioned address. Case-sensitive on purpose: the
 * harness writes lowercase prefixes and Postgres `~` is case-sensitive, so the
 * JS check and the SQL sweep agree. A test that invents a new prefix must add
 * it here, or its rows would be unsweepable (createTestUser tripwires on it).
 */
export const TEST_USER_PREFIXES = ['integration', 'itest', 'rw', 'csmtest'] as const;
export type TestUserPrefix = (typeof TEST_USER_PREFIXES)[number];

/** Postgres regex (for the `~` operator); `isSyntheticTestEmail` is its JS twin. */
export const TEST_USER_EMAIL_SQL_PATTERN = `^(${TEST_USER_PREFIXES.join('|')})_[0-9]+@`;
const TEST_USER_EMAIL_REGEX = new RegExp(TEST_USER_EMAIL_SQL_PATTERN);

export function isSyntheticTestEmail(email: string): boolean {
  return TEST_USER_EMAIL_REGEX.test(email);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/auth/syntheticEmail.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Point the integration harness at the module**

In `tests/integration/helpers.ts`:

(a) Add to the import block at the top (after the `@/db/schema` import):

```ts
import {
  TEST_USER_EMAIL_SQL_PATTERN,
  TEST_USER_PREFIXES,
  isSyntheticTestEmail,
  type TestUserPrefix,
} from '@/lib/auth/syntheticEmail';
```

(b) Replace the whole block from the doc comment `/** The closed set of email prefixes …` down to and including `const TEST_USER_EMAIL_REGEX = new RegExp(TEST_USER_EMAIL_SQL_PATTERN);` with:

```ts
/**
 * The closed set of email prefixes integration-test users may use, and the
 * orphan-sweep pattern derived from it, live in lib/auth/syntheticEmail.ts —
 * production code needs the same rule to keep synthetic rows out of the
 * Resend contact list. Re-exported so the harness keeps a single import.
 */
export { TEST_USER_EMAIL_SQL_PATTERN, TEST_USER_PREFIXES, type TestUserPrefix };
```

(c) In `createTestUser`, change the tripwire condition `if (!TEST_USER_EMAIL_REGEX.test(email)) {` to `if (!isSyntheticTestEmail(email)) {`. `sweepOrphanTestUsers` keeps using `TEST_USER_EMAIL_SQL_PATTERN` unchanged.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean (the integration harness is only compiled here, not run; Task 5 runs one integration file).

- [ ] **Step 7: Commit**

```bash
git add lib/auth/syntheticEmail.ts lib/auth/syntheticEmail.test.ts tests/integration/helpers.ts
git commit -F - <<'EOF'
refactor(auth): move the synthetic test-user email pattern into lib/auth/syntheticEmail.ts

Production code (the Resend contact sync) needs the same rule the integration
harness's orphan sweep uses, and lib/ must not import from tests/. One
definition, re-exported by the harness; createTestUser's tripwire uses the
shared isSyntheticTestEmail.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: The Resend contact helper, plus the env var

**Files:**
- Create: `lib/notifications/resendContacts.ts`
- Test: `lib/notifications/resendContacts.test.ts`
- Modify: `lib/env.ts` (after `RESEND_FROM`, line 15)
- Modify: `.env.example` (new section between ADMIN BOOTSTRAP and MCP)

Facts about the installed SDK (`resend` 6.12.3, `node_modules/resend/dist/index.d.mts`), so nobody has to rediscover them:
- `resend.contacts.create({ email, firstName?, lastName?, unsubscribed?, properties?, segments?: { id: string }[], topics? })` posts to `/contacts` (the overload with `audienceId` is deprecated and posts to `/audiences/{id}/contacts` — do not use it).
- `resend.contacts.remove({ email })` (or `{ id }`, or a bare string) deletes `/contacts/<email>`.
- Every call resolves to `{ data, error: null, headers } | { data: null, error: { name, message, statusCode }, headers }`; the SDK catches its own fetch, so a network failure comes back as `error.name === 'application_error'` with `statusCode: null` rather than a throw (Task 2 review corrected this bullet). The helper's try/catch guards `new Resend()`, which throws on a malformed key, and any future SDK change.

> **Review amendment (Task 2, commit 284e04f):** the code blocks below are the versions the implementer transcribed; the review then (a) replaced the `statusCode === 409 ||` half of the duplicate check with a message-only check and a comment on `resource_locked`, (b) added the `UNSAFE_IN_URL_PATH` guard to `removeResendContact`, (c) documented what the try/catch guards, (d) added a "Logging" paragraph and removed the address from the "already gone" line, (e) trimmed both env reads. The committed file and its 32 tests are the source of truth.
- Error names (`RESEND_ERROR_CODE_KEY`) include `not_found`, `validation_error`, `rate_limit_exceeded`, `application_error`; Resend documents no dedicated "contact already exists" error, hence the 409 / message check below.

- [ ] **Step 1: Write the failing tests**

Create `lib/notifications/resendContacts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreate, mockRemove } = vi.hoisted(() => ({ mockCreate: vi.fn(), mockRemove: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    contacts = { create: mockCreate, remove: mockRemove };
    constructor(public apiKey: string) {}
  },
}));

import { addResendContact, removeResendContact, splitName } from './resendContacts';

const ok = (data: unknown) => ({ data, error: null, headers: null });
const fail = (error: { name: string; message: string; statusCode: number | null }) => ({
  data: null,
  error,
  headers: null,
});

function configured() {
  vi.clearAllMocks();
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_SEGMENT_ID', 'seg_beta');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
function restore() {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}

describe('splitName', () => {
  it.each([
    [null, {}],
    [undefined, {}],
    ['', {}],
    ['   ', {}],
    ['Jane', { firstName: 'Jane' }],
    ['Jane Doe', { firstName: 'Jane', lastName: 'Doe' }],
    ['  Mary   Ann  Smith ', { firstName: 'Mary', lastName: 'Ann Smith' }],
  ])('%j → %j', (name, expected) => {
    expect(splitName(name as string | null | undefined)).toEqual(expected);
  });
});

describe('addResendContact', () => {
  beforeEach(configured);
  afterEach(restore);

  it('creates an account-level contact inside the configured segment, with the split name', async () => {
    mockCreate.mockResolvedValueOnce(ok({ object: 'contact', id: 'c_1' }));
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane Doe' })).toBe('added');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      email: 'jane@shop.co',
      firstName: 'Jane',
      lastName: 'Doe',
      segments: [{ id: 'seg_beta' }],
    });
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('sends no name fields when the member has no name', async () => {
    mockCreate.mockResolvedValueOnce(ok({ object: 'contact', id: 'c_2' }));
    await addResendContact({ email: 'anon@shop.co', name: null });
    expect(mockCreate).toHaveBeenCalledWith({ email: 'anon@shop.co', segments: [{ id: 'seg_beta' }] });
  });

  it('is a silent no-op when RESEND_SEGMENT_ID is unset (feature off)', async () => {
    vi.stubEnv('RESEND_SEGMENT_ID', '');
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns and skips when the segment is set but the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each(['itest_1700000000000@example.com', 'rw_5@shop.co', 'bot@example.com', 'nobody@localhost'])(
    'never adds a synthetic or undeliverable address (%s)',
    async (email) => {
      expect(await addResendContact({ email, name: null })).toBe('skipped');
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  it('treats "already exists" (409 or by message) as benign', async () => {
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'validation_error', message: 'Contact already exists', statusCode: 409 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('exists');
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'validation_error', message: 'A contact with this email already exists.', statusCode: 422 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('exists');
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('reports failed and logs when Resend returns any other error', async () => {
    mockCreate.mockResolvedValueOnce(
      fail({ name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 }),
    );
    expect(await addResendContact({ email: 'jane@shop.co', name: 'Jane' })).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('reports failed and never throws when the client throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('network down'));
    await expect(addResendContact({ email: 'jane@shop.co', name: 'Jane' })).resolves.toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('removeResendContact', () => {
  beforeEach(configured);
  afterEach(restore);

  it('removes the contact by email (every segment — the account is gone)', async () => {
    mockRemove.mockResolvedValueOnce(ok({ object: 'contact', contact: 'c_1', deleted: true }));
    expect(await removeResendContact('jane@shop.co')).toBe('removed');
    expect(mockRemove).toHaveBeenCalledWith({ email: 'jane@shop.co' });
  });

  it('is a silent no-op when the feature is off', async () => {
    vi.stubEnv('RESEND_SEGMENT_ID', '');
    expect(await removeResendContact('jane@shop.co')).toBe('skipped');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('skips synthetic and undeliverable addresses', async () => {
    expect(await removeResendContact('itest_1@example.com')).toBe('skipped');
    expect(await removeResendContact('bot@example.com')).toBe('skipped');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('treats an unknown contact as already gone', async () => {
    mockRemove.mockResolvedValueOnce(fail({ name: 'not_found', message: 'Contact not found', statusCode: 404 }));
    expect(await removeResendContact('gone@shop.co')).toBe('missing');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports failed and logs on any other error, and when the client throws', async () => {
    mockRemove.mockResolvedValueOnce(fail({ name: 'application_error', message: 'boom', statusCode: 500 }));
    expect(await removeResendContact('jane@shop.co')).toBe('failed');
    mockRemove.mockRejectedValueOnce(new Error('network down'));
    expect(await removeResendContact('jane@shop.co')).toBe('failed');
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run lib/notifications/resendContacts.test.ts`
Expected: FAIL — cannot find module `./resendContacts`.

- [ ] **Step 3: Implement the helper**

Create `lib/notifications/resendContacts.ts`:

```ts
// lib/notifications/resendContacts.ts
import { Resend } from 'resend';
import { isUndeliverableEmail } from './digest/recipients';
import { isSyntheticTestEmail } from '@/lib/auth/syntheticEmail';

/**
 * Keep Resend's contact list in step with the app's members, so a broadcast
 * (product news, beta announcements) reaches everyone without a hand-exported
 * CSV.
 *
 * Resend's model: contacts are account-level ("Global Contacts") and grouped
 * into Segments (formerly Audiences — the SDK's `audiences` is a deprecated
 * alias). A new member becomes a contact in the segment named by
 * RESEND_SEGMENT_ID; a deleted member's contact is removed altogether (every
 * segment), because the account is gone.
 *
 * CONTRACT — fail-soft, like sendWelcomeEmail and bumpUserActivity: these
 * never throw. A Resend hiccup is logged and reported in the return value;
 * it must never fail provisioning, 500 the Clerk webhook into a Svix retry
 * loop, or slow a member's first page render. The add is exactly-once by
 * construction (provisionUser calls it only when its upsert inserted the
 * row), so a repeat is an anomaly rather than a retry — "already exists" is
 * benign, and nothing here retries.
 *
 * Feature switch: RESEND_SEGMENT_ID unset → every call is a silent no-op
 * (local dev, unit tests, preview). Consent is NOT synced in either
 * direction: a Resend unsubscribe and weekly_digest_subscribed are separate.
 *
 * No `import 'server-only'` — keep this importable everywhere, like the
 * other senders in this directory.
 */

export type AddContactResult = 'added' | 'exists' | 'skipped' | 'failed';
export type RemoveContactResult = 'removed' | 'missing' | 'skipped' | 'failed';

const LOG = '[resend contacts]';

/**
 * Split the app's single `users.name` ("Jane Doe") into Resend's first/last
 * fields: the first whitespace-separated token, then the rest. Broadcast
 * templates greet with {{{FIRST_NAME|there}}}, so the first name is what
 * matters; a one-word name has no last name.
 */
export function splitName(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  const [firstName, ...rest] = tokens;
  return rest.length > 0 ? { firstName, lastName: rest.join(' ') } : { firstName };
}

/** Read at call time (not module load) so tests can stub and Vercel env edits apply per deploy. */
function settings(): { apiKey: string; segmentId: string } | null {
  const segmentId = process.env.RESEND_SEGMENT_ID;
  if (!segmentId) return null;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`${LOG} RESEND_SEGMENT_ID is set but RESEND_API_KEY is not — skipping`);
    return null;
  }
  return { apiKey, segmentId };
}

/** Never a real member: reserved test domains and the integration harness's synthetic users. */
function isNotAMember(email: string): boolean {
  return isUndeliverableEmail(email) || isSyntheticTestEmail(email);
}

export async function addResendContact(input: { email: string; name: string | null }): Promise<AddContactResult> {
  const cfg = settings();
  if (!cfg) return 'skipped';
  if (isNotAMember(input.email)) return 'skipped';
  try {
    const resend = new Resend(cfg.apiKey);
    const { error } = await resend.contacts.create({
      email: input.email,
      ...splitName(input.name),
      segments: [{ id: cfg.segmentId }],
    });
    if (!error) return 'added';
    // Resend documents no dedicated duplicate-contact error; a conflict status
    // or an "already exists" message is the closest signal, and a duplicate is
    // harmless here (the contact is already on the list).
    if (error.statusCode === 409 || /already exist/i.test(error.message)) {
      console.warn(`${LOG} contact already exists for ${input.email} — left as is`);
      return 'exists';
    }
    console.error(`${LOG} could not add ${input.email}:`, error);
    return 'failed';
  } catch (e) {
    console.error(`${LOG} add threw for ${input.email}:`, e);
    return 'failed';
  }
}

export async function removeResendContact(email: string): Promise<RemoveContactResult> {
  const cfg = settings();
  if (!cfg) return 'skipped';
  if (isNotAMember(email)) return 'skipped';
  try {
    const resend = new Resend(cfg.apiKey);
    const { error } = await resend.contacts.remove({ email });
    if (!error) return 'removed';
    if (error.name === 'not_found' || error.statusCode === 404) {
      console.warn(`${LOG} no contact to remove for ${email}`);
      return 'missing';
    }
    console.error(`${LOG} could not remove ${email}:`, error);
    return 'failed';
  } catch (e) {
    console.error(`${LOG} remove threw for ${email}:`, e);
    return 'failed';
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/notifications/resendContacts.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Declare and document the env var**

In `lib/env.ts`, directly after the `RESEND_FROM` line, add:

```ts
  /** Resend Segment new members join (and leave on deletion); unset = contact sync off. See lib/notifications/resendContacts.ts */
  RESEND_SEGMENT_ID: z.string().min(1).optional(),
```

In `.env.example`, insert this section between the ADMIN BOOTSTRAP block and the MCP block (the two existing Resend vars were never documented there; they belong in the same section):

```
# ============== RESEND (email) ==============
# Get from resend.com → API Keys. Unset = every send is skipped with a warning (fine in local dev).
RESEND_API_KEY=
# From address for transactional email; defaults to KeywordQuarry <notifications@keywordquarry.com>
RESEND_FROM=
# Contact sync: the Resend Segment (Contacts → Segments → open it → copy the id)
# that every new member is added to, and removed from when their account is
# deleted. Unset = contact sync off. See lib/notifications/resendContacts.ts
RESEND_SEGMENT_ID=
```

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. (If `tsc` rejects the `create` call, the spread has widened `firstName` to `string | undefined` against an overload — keep the object literal exactly as above; both overloads accept optional name fields.)

- [ ] **Step 7: Commit**

```bash
git add lib/notifications/resendContacts.ts lib/notifications/resendContacts.test.ts lib/env.ts .env.example
git commit -F - <<'EOF'
feat(notifications): Resend contact helper — add a member to the RESEND_SEGMENT_ID segment, remove on deletion

Fail-soft by contract (never throws, one attempt, logged), a silent no-op
until RESEND_SEGMENT_ID is set, and it never touches synthetic test users or
undeliverable addresses. "Already exists" and "not found" are benign. Uses
Resend's account-level Contacts API with segments (audiences are deprecated
in the SDK).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: Add the contact on first provisioning, from both paths

**Files:**
- Modify: `lib/auth/provisionUser.ts` (whole file)
- Modify: `lib/auth/provisionUser.test.ts` (whole file)
- Modify: `lib/auth/getCurrentUser.ts` (line 25 comment, line 58 option)
- Modify: `lib/auth/getCurrentUser.test.ts` (the two `{ welcome: 'after' }` expectations and the test title that mentions "welcome deferred")

Context: `provisionUser` is called by the Clerk webhook (inline) and by `getCurrentUser` (on demand, `{ welcome: 'after' }`). The `created` flag from `syncUserFromClerk`'s atomic upsert already makes the welcome email exactly-once; the contact add joins it under the same gate. The option is renamed to `sideEffects` because it now governs both.

- [ ] **Step 1: Write the failing tests**

Replace `lib/auth/provisionUser.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSync, mockWelcome, mockAddContact, mockAfter } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockWelcome: vi.fn().mockResolvedValue(true),
  mockAddContact: vi.fn().mockResolvedValue('added'),
  mockAfter: vi.fn(),
}));

vi.mock('./syncUser', () => ({ syncUserFromClerk: mockSync }));
vi.mock('@/lib/notifications/sendWelcomeEmail', () => ({ sendWelcomeEmail: mockWelcome }));
vi.mock('@/lib/notifications/resendContacts', () => ({ addResendContact: mockAddContact }));
vi.mock('next/server', () => ({ after: mockAfter }));

import { provisionUser } from './provisionUser';

const input = { clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane' };
const created = () =>
  mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: true });
const existed = () =>
  mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'jane@shop.co', name: 'Jane' }, created: false });

describe('provisionUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs both signup side effects inline, exactly when the row was just created', async () => {
    created();
    const r = await provisionUser(input);
    expect(r.created).toBe(true);
    expect(mockSync).toHaveBeenCalledWith(input);
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'jane@shop.co', name: 'Jane' });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('does nothing when the row already existed', async () => {
    existed();
    const r = await provisionUser(input);
    expect(r.created).toBe(false);
    expect(mockWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('skips both side effects for an undeliverable address even on first creation', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'x@example.com', name: null }, created: true });
    await provisionUser({ clerkUserId: 'user_2', email: 'x@example.com', name: null });
    expect(mockWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('passes a null name through to the contact when the member has none', async () => {
    mockSync.mockResolvedValueOnce({ user: { id: 'u', email: 'anon@shop.co', name: null }, created: true });
    await provisionUser({ clerkUserId: 'user_4', email: 'anon@shop.co', name: null });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'anon@shop.co', name: null });
  });

  it("in 'after' mode, schedules both side effects for after the response instead of awaiting them", async () => {
    created();
    const r = await provisionUser(input, { sideEffects: 'after' });
    expect(r.created).toBe(true);
    expect(mockWelcome).not.toHaveBeenCalled(); // nothing runs inside the request
    expect(mockAddContact).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await (mockAfter.mock.calls[0][0] as () => Promise<unknown>)(); // run the scheduled task
    expect(mockWelcome).toHaveBeenCalledWith({ to: 'jane@shop.co', name: 'Jane' });
    expect(mockAddContact).toHaveBeenCalledWith({ email: 'jane@shop.co', name: 'Jane' });
  });

  it("in 'after' mode, schedules nothing when the row already existed", async () => {
    existed();
    await provisionUser(input, { sideEffects: 'after' });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockWelcome).not.toHaveBeenCalled();
    expect(mockAddContact).not.toHaveBeenCalled();
  });

  it('still adds the contact when the welcome email reports failure (independent side effects)', async () => {
    created();
    mockWelcome.mockResolvedValueOnce(false);
    await provisionUser(input);
    expect(mockAddContact).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty email without syncing', async () => {
    await expect(provisionUser({ clerkUserId: 'user_3', email: '', name: null })).rejects.toThrow(/email/);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('returns the synced user untouched', async () => {
    const user = { id: 'u', clerkUserId: 'user_1', email: 'jane@shop.co', name: 'Jane', role: 'standard_user' };
    mockSync.mockResolvedValueOnce({ user, created: false });
    expect((await provisionUser(input)).user).toBe(user);
  });
});
```

In `lib/auth/getCurrentUser.test.ts`, change both `{ welcome: 'after' }` expectations to `{ sideEffects: 'after' }` and the title `'provisions the row on the spot (welcome deferred past the response) when Clerk has a session but no row exists'` to `'provisions the row on the spot (signup side effects deferred past the response) when Clerk has a session but no row exists'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run lib/auth/provisionUser.test.ts lib/auth/getCurrentUser.test.ts`
Expected: FAIL — `mockAddContact` never called; the getCurrentUser expectations see `{ welcome: 'after' }`.

- [ ] **Step 3: Implement**

Replace `lib/auth/provisionUser.ts` with:

```ts
import { after } from 'next/server';
import { syncUserFromClerk, type SyncUserInput, type SyncUserResult } from './syncUser';
import { sendWelcomeEmail } from '@/lib/notifications/sendWelcomeEmail';
import { addResendContact } from '@/lib/notifications/resendContacts';
import { isUndeliverableEmail } from '@/lib/notifications/digest/recipients';

export interface ProvisionOptions {
  /**
   * When to run the one-time signup side effects (welcome email, Resend
   * contact). 'inline' (default): await them — right for the webhook, whose
   * function may be frozen after it responds. 'after': schedule them with
   * next/server's after() so they run once the response is done — right for
   * the on-demand path, which sits inside a member's first page render and
   * must not wait on Resend.
   */
  sideEffects?: 'inline' | 'after';
}

/**
 * Sync the app row for a Clerk user and, once per user, run the signup side
 * effects: the welcome email and the Resend contact (segment membership for
 * broadcasts).
 *
 * Shared by the Clerk webhook (user.created / user.updated) and
 * getCurrentUser's on-demand path, so whichever one wins the race to insert
 * the row is the one that welcomes the member. `created` comes from the
 * atomic upsert, so webhook retries and the losing racer never send a second
 * email or add a second contact. Both side effects are fail-soft by contract
 * (one attempt; a Resend hiccup is logged, never retried, and never fails
 * provisioning) and independent of each other.
 */
export async function provisionUser(
  input: SyncUserInput,
  opts: ProvisionOptions = {},
): Promise<SyncUserResult> {
  if (!input.email) throw new Error('provisionUser: email is required');
  const result = await syncUserFromClerk(input);
  if (result.created && result.user.email && !isUndeliverableEmail(result.user.email)) {
    const email = result.user.email;
    const name = result.user.name ?? null;
    const onboard = async () => {
      await Promise.all([sendWelcomeEmail({ to: email, name }), addResendContact({ email, name })]);
    };
    if (opts.sideEffects === 'after') after(onboard);
    else await onboard();
  }
  return result;
}
```

In `lib/auth/getCurrentUser.ts`: line 58 becomes `const { user } = await provisionUser({ clerkUserId, email, name }, { sideEffects: 'after' });` and the doc comment's `(welcome email deferred past the response)` becomes `(welcome email and Resend contact deferred past the response)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/auth/provisionUser.test.ts lib/auth/getCurrentUser.test.ts app/api/webhooks/clerk/route.test.ts`
Expected: PASS. (The webhook test uses the real `provisionUser` with the real helper; with no `RESEND_SEGMENT_ID` in the test env the helper is a silent no-op, so nothing reaches the network. Task 4 mocks it explicitly.)

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean — in particular no remaining `welcome:` option anywhere (`grep -rn "welcome: '" lib app` prints nothing).

- [ ] **Step 6: Commit**

```bash
git add lib/auth/provisionUser.ts lib/auth/provisionUser.test.ts lib/auth/getCurrentUser.ts lib/auth/getCurrentUser.test.ts
git commit -F - <<'EOF'
feat(auth): add new members to the Resend segment on first provisioning

Joins the welcome email under provisionUser's existing exactly-once gate
(the atomic upsert's `created`), so the webhook, its Svix retries and the
on-demand path together add each member once. Same scheduling as the
welcome: inline for the webhook, after() for the on-demand path. The option
is renamed welcome → sideEffects since it now governs both.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: Remove the contact when Clerk deletes a user

**Files:**
- Modify: `app/api/webhooks/clerk/route.ts` (import block; the `user.deleted` branch, lines 91–103)
- Modify: `app/api/webhooks/clerk/route.test.ts` (mocks at the top; new `user.deleted` tests; two assertions added to existing tests)

Read `node_modules/next/dist/docs/` on route handlers before editing (nothing about the handler's shape changes; this is a reminder of the project rule).

- [ ] **Step 1: Write the failing tests**

In `app/api/webhooks/clerk/route.test.ts`:

(a) Extend the first hoisted block and add the module mock (place the mock next to the `sendWelcomeEmail` one):

```ts
const { mockSyncUser, mockSendWelcome, mockAddContact, mockRemoveContact } = vi.hoisted(() => ({
  mockSyncUser: vi.fn().mockResolvedValue({
    user: { id: 'uuid', clerkUserId: 'user_123', email: 'test@x.com', name: 'Test User' },
    created: true,
  }),
  mockSendWelcome: vi.fn().mockResolvedValue(true),
  mockAddContact: vi.fn().mockResolvedValue('added'),
  mockRemoveContact: vi.fn().mockResolvedValue('removed'),
}));
```

```ts
vi.mock('@/lib/notifications/resendContacts', () => ({
  addResendContact: mockAddContact,
  removeResendContact: mockRemoveContact,
}));
```

(b) Replace the db mock (the `mockDbDelete` hoisted block and its `vi.mock('@/db/client', …)`) with one whose chain ends in `.returning()`:

```ts
// Mock the db client for user.deleted handling: delete → where → returning
const { mockDbDelete, mockReturning } = vi.hoisted(() => {
  const mockReturning = vi.fn().mockResolvedValue([]);
  return {
    mockReturning,
    mockDbDelete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: mockReturning }) }),
  };
});

vi.mock('@/db/client', () => ({
  db: { delete: mockDbDelete },
}));
```

(c) In the existing test `'sends the welcome email exactly on first creation'` add `expect(mockAddContact).toHaveBeenCalledWith({ email: 'test@x.com', name: 'Test User' });` and in `'does not send the welcome email on a webhook retry (row already existed)'` add `expect(mockAddContact).not.toHaveBeenCalled();`.

(d) Add a nested describe before the final `'rejects requests missing svix headers'` test:

```ts
  describe('user.deleted', () => {
    const deleted = (id = 'user_del') => makeRequest({ type: 'user.deleted', data: { id, deleted: true } });

    it('deletes the row and removes the Resend contact for its email', async () => {
      mockReturning.mockResolvedValueOnce([{ email: 'gone@shop.co' }]);
      const res = await POST(deleted());
      expect(res.status).toBe(200);
      expect(mockDbDelete).toHaveBeenCalledTimes(1);
      expect(mockRemoveContact).toHaveBeenCalledWith('gone@shop.co');
    });

    it('removes nothing from Resend when no row matched (already gone)', async () => {
      mockReturning.mockResolvedValueOnce([]);
      const res = await POST(deleted());
      expect(res.status).toBe(200);
      expect(mockRemoveContact).not.toHaveBeenCalled();
    });

    it('still acknowledges with 200 when the Resend removal reports failure (fail-soft)', async () => {
      mockReturning.mockResolvedValueOnce([{ email: 'gone@shop.co' }]);
      mockRemoveContact.mockResolvedValueOnce('failed');
      const res = await POST(deleted());
      expect(res.status).toBe(200);
    });

    it('returns 500 (so Svix retries) when the row delete itself throws, without touching Resend', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReturning.mockRejectedValueOnce(new Error('neon blip'));
      const res = await POST(deleted());
      expect(res.status).toBe(500);
      expect(mockRemoveContact).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run app/api/webhooks/clerk/route.test.ts`
Expected: FAIL — the route awaits `db.delete().where()` directly (a mock object, not the `.returning()` promise), so `mockRemoveContact` is never called.

- [ ] **Step 3: Implement**

In `app/api/webhooks/clerk/route.ts` add the import (after the `provisionUser` import):

```ts
import { removeResendContact } from '@/lib/notifications/resendContacts';
```

and replace the `user.deleted` branch body (keep its existing FK comment above it) with:

```ts
      const [gone] = await db
        .delete(users)
        .where(eq(users.clerkUserId, event.data.id))
        .returning({ email: users.email });
      // The member is gone: drop their Resend contact too. Fail-soft — a
      // Resend hiccup is logged, never a 500 (the row is already deleted, so
      // a Svix retry could not recover the email anyway).
      if (gone) await removeResendContact(gone.email);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run app/api/webhooks/clerk/route.test.ts`
Expected: PASS (all existing tests plus the four new ones).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/clerk/route.ts app/api/webhooks/clerk/route.test.ts
git commit -F - <<'EOF'
feat(webhooks): remove the Resend contact when Clerk deletes a user

user.deleted now deletes the row RETURNING email and removes that contact
(every segment — the account is gone). Fail-soft: a Resend failure is logged
and the webhook still acknowledges; a DB failure still 500s so Svix retries.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: Close out — full checks, final review, docs, owner-gated ship

**Files:**
- Modify: this plan (Results section)
- Memory: `resend-audience-sync.md` (status), `MEMORY.md` (one-line hook)

- [ ] **Step 1: Full unit suite, typecheck, lint**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 2: One integration file, to prove the moved pattern still drives the harness**

Run: `RUN_INTEGRATION=1 pnpm vitest run tests/integration/syncUser.test.ts`
Expected: PASS, and the teardown prints no "swept N orphaned test user(s)" warning (the sweep uses the re-exported `TEST_USER_EMAIL_SQL_PATTERN`). This runs against the production database with synthetic `itest_<epoch>@example.com` users only; `.env.local` has no `RESEND_SEGMENT_ID`, so the helper is off, and `syncUserFromClerk` never reaches `provisionUser` anyway.

- [ ] **Step 3: Final whole-diff review**

Dispatch a reviewer over `git diff 5cd2058..HEAD` (everything since the exclude-terms tooltip commit, excluding the plan file) against this plan's design table. Fix anything blocking; fold in nits.

- [ ] **Step 4: Record the outcome**

Append a Results section to this plan (commits, review verdict, checks) and update the memory file's status; commit the plan with the standard trailer.

- [ ] **Step 5: Ship (OWNER-GATED)**

In this order:
1. The owner opens Resend → Contacts → Segments, opens the segment the beta contacts were imported into (or creates one), copies its id, and sets `RESEND_SEGMENT_ID` in Vercel → Project → Settings → Environment Variables → Production. (Setting it before the push means the deploy that carries the code is the one that turns the feature on; setting it after needs a redeploy.)
2. On the owner's go: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (no running Keepa run, no importing batch), then `git push origin main`; watch Vercel and the Railway worker until both are green.
3. Smoke, by the owner (creating accounts is theirs to do): sign up a throwaway account (a plus-address on their own mailbox works), confirm the contact appears in the segment with the first name filled in, then delete that user in the Clerk dashboard and confirm the contact disappears. Any failure shows up in Vercel logs under `[resend contacts]`.

---

## Not in scope

- Propagating an email change (`user.updated`) to the Resend contact — the contact keeps the address it was created with. Consequence (Task 4 review): a member who changed their address and later deletes their account is removed by the new address, Resend answers `not_found` (logged as already gone) and the original contact lingers. Rare; a follow-up if it bites.
- Backfilling members who signed up between the CSV export and this deploy — an untracked one-off script, on the owner's go, if the gap matters.
- Syncing Resend unsubscribes into `weekly_digest_subscribed` or the reverse; Resend webhooks.
- Any schema change.
