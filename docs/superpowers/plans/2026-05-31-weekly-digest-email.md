# Weekly Digest Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin broadcast a weekly digest email to all subscribed users — a lightweight "new week is live" message for users with no watched keywords, and a full per-keyword movement table for users who watch keywords.

**Architecture:** A new `/admin/digests` page fires a `digest.send-weekly` Inngest event (current snapshot week only). The Inngest function runs an idempotent, chunked fan-out via Resend's batch API, writing per-`(week, user)` status rows. Email bodies are produced by a pure builder mirroring the existing `buildImportEmail`/`sendImportEmail` split. A signed-token footer link drives one-click unsubscribe.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM, Neon Postgres, Inngest, Resend, Vitest, Node `crypto` (HMAC).

**Spec:** `docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md`

---

## File structure

**New files:**
- `db/migrations/0033_weekly_digest.sql` — opt-out column + 2 tracking tables
- `db/schema/weeklyDigest.ts` — drizzle tables `weeklyDigestRuns`, `weeklyDigestSends`
- `lib/notifications/digest/types.ts` — shared interfaces (`DigestRecipient`, `DigestKeywordRow`, `DigestVariant`, `BuiltEmail`)
- `lib/notifications/digest/unsubToken.ts` (+ `.test.ts`) — HMAC sign/verify
- `lib/notifications/digest/recipients.ts` (+ `.test.ts`) — `variantFor`, `chunk`, `rollupRunStatus` pure helpers
- `lib/notifications/digest/buildDigestEmail.ts` (+ `.test.ts`) — pure email builder (both variants)
- `lib/notifications/digest/loadDigestData.ts` (+ `.test.ts`) — recipients/watchlist/weeks loaders + `groupAndSortWatchlistRows` pure transform
- `lib/notifications/digest/sendWeeklyDigest.ts` — send orchestration
- `inngest/functions/sendWeeklyDigest.ts` — Inngest function wrapper
- `app/admin/digests/page.tsx` — status page
- `app/admin/digests/SendDigestButton.tsx` — client button
- `app/admin/digests/preview/page.tsx` — non-sending browser preview
- `app/api/admin/digests/send/route.ts` — fires the Inngest event
- `app/api/notifications/unsubscribe/route.ts` — GET unsub + POST re-subscribe

**Modified files:**
- `db/schema/users.ts` — add `weeklyDigestSubscribed`
- `db/schema/index.ts` — export the new tables
- `inngest/functions/index.ts` — register `sendWeeklyDigestFn`
- `app/admin/layout.tsx` — add a "Weekly digests" nav link

## Shared types (defined once in Task 2.1, referenced everywhere)

```ts
export type DigestVariant = 'watchlist' | 'broadcast';

export interface DigestRecipient {
  userId: string;
  email: string;
  watchlistCount: number;
}

export interface DigestKeywordRow {
  searchTermId: string;
  searchTermRaw: string;
  currentRank: number | null;
  priorWeekRank: number | null;
  rank4wAgo: number | null;
  improvement1w: number | null;
  estMonthlyVolume: number | null;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}
```

## Environment variables

- `RESEND_API_KEY`, `RESEND_FROM`, `APP_PUBLIC_URL` — already used by existing notifications.
- `DIGEST_UNSUB_SECRET` — **new**. HMAC secret for unsubscribe tokens. Read directly via `process.env` (matching the notifications code's direct-env style). Falls back to a dev-only constant with a warning when unset, so local dev works; **must** be set in Vercel for production. Added to `.env.local` + Vercel in Phase 7.

---

## Phase 1 — Schema + subscribe-on-signup (~30 min)

### Task 1.1 — Migration file

**Files:**
- Create: `db/migrations/0033_weekly_digest.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Weekly digest email: opt-out flag + send-tracking tables.
--
-- See docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md.
--
-- weekly_digest_subscribed defaults to true so the first broadcast
-- reaches everyone and new accounts inherit subscription automatically
-- (syncUserFromClerk's INSERT needs no change).
--
-- weekly_digest_runs: one row per week sent. PK on week_end_date is the
-- idempotency gate — a week can never be sent twice.
--
-- weekly_digest_sends: one row per (week, user). The grain at which
-- sends are idempotent and retryable; retry re-sends only failed rows.

ALTER TABLE users
  ADD COLUMN weekly_digest_subscribed BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE weekly_digest_runs (
  week_end_date    date        PRIMARY KEY,
  status           text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  recipients_count int         NOT NULL DEFAULT 0,
  sent_count       int         NOT NULL DEFAULT 0,
  failed_count     int         NOT NULL DEFAULT 0,
  triggered_by     uuid        REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE weekly_digest_sends (
  week_end_date  date        NOT NULL REFERENCES weekly_digest_runs(week_end_date) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant        text        NOT NULL,
  status         text        NOT NULL,
  resend_id      text,
  error          text,
  sent_at        timestamptz,
  PRIMARY KEY (week_end_date, user_id)
);

CREATE INDEX weekly_digest_sends_failed_idx
  ON weekly_digest_sends (week_end_date)
  WHERE status = 'failed';
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:migrate`
Expected: migration 0033 applies cleanly. (If drizzle-kit's journal skips it, confirm the file is named `0033_weekly_digest.sql` and sits alongside `0032_watchlist_items.sql`.)

Verify the column default took effect:
Run: `npm run db:studio` (or any SQL client) and confirm `users.weekly_digest_subscribed` exists with default `true`, and the two tables exist.

### Task 1.2 — Drizzle schema

**Files:**
- Create: `db/schema/weeklyDigest.ts`
- Modify: `db/schema/users.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

```ts
// db/schema/weeklyDigest.ts
import { pgTable, uuid, date, text, integer, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Weekly digest send tracking. See migration 0033 +
 * docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md.
 *
 * weekly_digest_runs: one row per week sent; PK on week_end_date is the
 * idempotency gate. weekly_digest_sends: one row per (week, user) — the
 * grain at which sends are idempotent + retryable.
 */
export const weeklyDigestRuns = pgTable('weekly_digest_runs', {
  weekEndDate: date('week_end_date').primaryKey(),
  // 'sending' | 'sent' | 'sent_with_failures' | 'failed'
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  recipientsCount: integer('recipients_count').notNull().default(0),
  sentCount: integer('sent_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
});

export const weeklyDigestSends = pgTable(
  'weekly_digest_sends',
  {
    weekEndDate: date('week_end_date')
      .notNull()
      .references(() => weeklyDigestRuns.weekEndDate, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),       // 'watchlist' | 'broadcast'
    status: text('status').notNull(),          // 'pending' | 'sent' | 'failed'
    resendId: text('resend_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekEndDate, t.userId] }),
    failedIdx: index('weekly_digest_sends_failed_idx').on(t.weekEndDate),
  }),
);

export type WeeklyDigestRunRow = typeof weeklyDigestRuns.$inferSelect;
export type WeeklyDigestSendRow = typeof weeklyDigestSends.$inferSelect;
```

- [ ] **Step 2: Add the users column**

In `db/schema/users.ts`, add to the imports (line 1) so `boolean` is available:
```ts
import { pgTable, uuid, varchar, timestamp, pgEnum, uniqueIndex, boolean } from 'drizzle-orm/pg-core';
```
Then add the column after `lastLoginAt` (line 14):
```ts
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    weeklyDigestSubscribed: boolean('weekly_digest_subscribed').notNull().default(true),
```

- [ ] **Step 3: Export the new tables from the schema index**

In `db/schema/index.ts`, add:
```ts
export { weeklyDigestRuns, weeklyDigestSends } from './weeklyDigest';
export type { WeeklyDigestRunRow, WeeklyDigestSendRow } from './weeklyDigest';
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0033_weekly_digest.sql db/schema/weeklyDigest.ts db/schema/users.ts db/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(digest): schema migration 0033 + drizzle tables

Adds users.weekly_digest_subscribed (default true) and the
weekly_digest_runs / weekly_digest_sends tracking tables. Subscribe-on-
signup is automatic via the column default — no auth-path change.

Weekly digest, Phase 1.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Pure core (TDD) (~2h)

### Task 2.1 — Shared types

**Files:**
- Create: `lib/notifications/digest/types.ts`

- [ ] **Step 1: Write the types module**

```ts
// lib/notifications/digest/types.ts
/**
 * Shared types for the weekly digest. Kept in one place so the builder,
 * loaders, and send engine all reference identical shapes.
 */

export type DigestVariant = 'watchlist' | 'broadcast';

/** A user eligible to receive the digest, with enough info to pick a variant. */
export interface DigestRecipient {
  userId: string;
  email: string;
  watchlistCount: number;
}

/** One watched keyword's current-week metrics, as rendered in the email table. */
export interface DigestKeywordRow {
  searchTermId: string;
  searchTermRaw: string;
  currentRank: number | null;
  priorWeekRank: number | null;
  rank4wAgo: number | null;
  improvement1w: number | null;   // prior_week_rank - current_rank; positive = improvement
  estMonthlyVolume: number | null;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

### Task 2.2 — Unsubscribe token (sign/verify)

**Files:**
- Create: `lib/notifications/digest/unsubToken.ts`
- Create: `lib/notifications/digest/unsubToken.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/notifications/digest/unsubToken.test.ts
import { describe, it, expect } from 'vitest';
import { signUnsubToken, verifyUnsubToken } from './unsubToken';

const USER_ID = '00000000-0000-0000-0000-000000000001';

describe('unsubToken', () => {
  it('round-trips a userId through sign → verify', () => {
    const token = signUnsubToken(USER_ID);
    expect(verifyUnsubToken(token)).toEqual({ userId: USER_ID });
  });

  it('returns null for a tampered token', () => {
    const token = signUnsubToken(USER_ID);
    // Flip the last char of the signature.
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyUnsubToken(tampered)).toBeNull();
  });

  it('returns null for a token with the wrong number of parts', () => {
    expect(verifyUnsubToken('garbage')).toBeNull();
    expect(verifyUnsubToken('a.b.c')).toBeNull();
  });

  it('returns null for a payload with the wrong purpose', () => {
    // Hand-craft a token with a valid signature but wrong purpose by
    // round-tripping through the same HMAC the module uses is not
    // possible from outside; instead assert that a payload missing the
    // expected purpose fails. We simulate by signing then mutating the
    // base64 payload, which breaks the signature → null. (Purpose is
    // enforced structurally: verify only accepts purpose === 'unsubscribe-digest'.)
    const token = signUnsubToken(USER_ID);
    const [, sig] = token.split('.');
    const fakePayload = Buffer.from(
      JSON.stringify({ userId: USER_ID, purpose: 'something-else' }),
    ).toString('base64url');
    expect(verifyUnsubToken(`${fakePayload}.${sig}`)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(verifyUnsubToken('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/notifications/digest/unsubToken.test.ts`
Expected: FAIL — module/exports not defined.

- [ ] **Step 3: Implement the token module**

```ts
// lib/notifications/digest/unsubToken.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, non-expiring unsubscribe tokens for the weekly digest.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 * The payload is { userId, purpose: 'unsubscribe-digest' }. We sign the
 * userId (rather than putting it raw in the URL) so nobody can
 * unsubscribe another user by editing the link. No expiry — an
 * unsubscribe link from an old email must always work.
 *
 * Secret: DIGEST_UNSUB_SECRET. Falls back to a dev-only constant (with a
 * warning) so local dev works; MUST be set in production.
 */

const PURPOSE = 'unsubscribe-digest';

function secret(): string {
  const s = process.env.DIGEST_UNSUB_SECRET;
  if (!s) {
    console.warn(
      '[unsubToken] DIGEST_UNSUB_SECRET not set — using an insecure dev fallback. Set this in production.',
    );
    return 'dev-insecure-digest-secret';
  }
  return s;
}

interface UnsubPayload {
  userId: string;
  purpose: typeof PURPOSE;
}

function hmac(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function signUnsubToken(userId: string): string {
  const payload: UnsubPayload = { userId, purpose: PURPOSE };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${hmac(payloadB64)}`;
}

export function verifyUnsubToken(token: string): { userId: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  // Constant-time signature comparison.
  const expected = hmac(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as Partial<UnsubPayload>;
    if (payload.purpose !== PURPOSE || typeof payload.userId !== 'string') {
      return null;
    }
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/notifications/digest/unsubToken.test.ts`
Expected: PASS (5 tests).

### Task 2.3 — Recipient helpers (variantFor, chunk, rollupRunStatus)

**Files:**
- Create: `lib/notifications/digest/recipients.ts`
- Create: `lib/notifications/digest/recipients.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/notifications/digest/recipients.test.ts
import { describe, it, expect } from 'vitest';
import { variantFor, chunk, rollupRunStatus } from './recipients';

describe('variantFor', () => {
  it('returns watchlist when count > 0', () => {
    expect(variantFor(1)).toBe('watchlist');
    expect(variantFor(100)).toBe('watchlist');
  });
  it('returns broadcast when count is 0', () => {
    expect(variantFor(0)).toBe('broadcast');
  });
});

describe('chunk', () => {
  it('splits into groups of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('returns one chunk when under the size', () => {
    expect(chunk([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });
  it('returns empty array for empty input', () => {
    expect(chunk([], 100)).toEqual([]);
  });
  it('handles exact multiples', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
});

describe('rollupRunStatus', () => {
  it('is "sent" when there are no failures', () => {
    expect(rollupRunStatus({ sent: 10, failed: 0 })).toBe('sent');
  });
  it('is "sent_with_failures" when some failed but some sent', () => {
    expect(rollupRunStatus({ sent: 7, failed: 3 })).toBe('sent_with_failures');
  });
  it('is "failed" when everything failed', () => {
    expect(rollupRunStatus({ sent: 0, failed: 5 })).toBe('failed');
  });
  it('is "sent" for a zero-recipient run (nothing to fail)', () => {
    expect(rollupRunStatus({ sent: 0, failed: 0 })).toBe('sent');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/notifications/digest/recipients.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Implement the helpers**

```ts
// lib/notifications/digest/recipients.ts
import type { DigestVariant } from './types';

/** Watchlist variant iff the user watches at least one keyword. */
export function variantFor(watchlistCount: number): DigestVariant {
  return watchlistCount > 0 ? 'watchlist' : 'broadcast';
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Roll the per-user send outcome counts up to a run-level status.
 * Zero recipients (or all-sent) → 'sent'; mixed → 'sent_with_failures';
 * all-failed → 'failed'.
 */
export function rollupRunStatus(counts: { sent: number; failed: number }):
  | 'sent'
  | 'sent_with_failures'
  | 'failed' {
  if (counts.failed === 0) return 'sent';
  if (counts.sent === 0) return 'failed';
  return 'sent_with_failures';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/notifications/digest/recipients.test.ts`
Expected: PASS.

### Task 2.4 — Email builder (both variants)

**Files:**
- Create: `lib/notifications/digest/buildDigestEmail.ts`
- Create: `lib/notifications/digest/buildDigestEmail.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/notifications/digest/buildDigestEmail.test.ts
import { describe, it, expect } from 'vitest';
import { buildDigestEmail } from './buildDigestEmail';
import type { DigestKeywordRow } from './types';

const common = {
  weekEndDate: '2026-05-23',
  appUrl: 'https://app.example.com',
  unsubscribeUrl: 'https://app.example.com/api/notifications/unsubscribe?token=TKN',
};

const row = (over: Partial<DigestKeywordRow>): DigestKeywordRow => ({
  searchTermId: 'id-1',
  searchTermRaw: 'wireless earbuds',
  currentRank: 1204,
  priorWeekRank: 1520,
  rank4wAgo: 2100,
  improvement1w: 316,
  estMonthlyVolume: 45000,
  ...over,
});

describe('buildDigestEmail — broadcast', () => {
  const built = buildDigestEmail({ variant: 'broadcast', ...common });

  it('uses the broadcast subject', () => {
    expect(built.subject).toBe('Amazon Keywords Updated! Explore new week of keyword changes');
  });
  it('links to the explorer', () => {
    expect(built.html).toContain(`${common.appUrl}/explorer`);
  });
  it('includes the unsubscribe link in html and text', () => {
    expect(built.html).toContain(common.unsubscribeUrl);
    expect(built.text).toContain(common.unsubscribeUrl);
  });
  it('mentions the week', () => {
    expect(built.text).toContain('2026-05-23');
  });
});

describe('buildDigestEmail — watchlist', () => {
  const rows = [
    row({ searchTermId: 'a', searchTermRaw: 'small mover', improvement1w: 10, currentRank: 500, priorWeekRank: 510, rank4wAgo: 520, estMonthlyVolume: 1000 }),
    row({ searchTermId: 'b', searchTermRaw: 'big mover', improvement1w: -1710, currentRank: 8910, priorWeekRank: 7200, rank4wAgo: 6800, estMonthlyVolume: 12000 }),
    row({ searchTermId: 'c', searchTermRaw: 'no prior', improvement1w: null, currentRank: 3000, priorWeekRank: null, rank4wAgo: null, estMonthlyVolume: null }),
  ];
  const built = buildDigestEmail({ variant: 'watchlist', rows, ...common });

  it('uses the watchlist subject', () => {
    expect(built.subject).toBe('Amazon Keywords Updated! See what changed in your Watchlist and explore today!');
  });

  it('renders every keyword', () => {
    expect(built.html).toContain('small mover');
    expect(built.html).toContain('big mover');
    expect(built.html).toContain('no prior');
  });

  it('links each keyword to its detail page', () => {
    expect(built.html).toContain(`${common.appUrl}/explorer/keyword/a`);
    expect(built.html).toContain(`${common.appUrl}/explorer/keyword/b`);
  });

  it('renders a positive delta in green and negative in red', () => {
    // green for +10 improvement, red for -1710
    expect(built.html).toMatch(/#15803d[^<]*\+10/);   // green hex then +10
    expect(built.html).toMatch(/#b91c1c[^<]*(−|-)1,?710/); // red hex then -1710
  });

  it('shows "not ranked this week" when currentRank is null', () => {
    const r = [row({ searchTermId: 'z', searchTermRaw: 'gone', currentRank: null, improvement1w: null })];
    const b = buildDigestEmail({ variant: 'watchlist', rows: r, ...common });
    expect(b.html).toContain('not ranked this week');
  });

  it('includes the explore/watchlist CTA + unsubscribe link', () => {
    expect(built.html).toContain(`${common.appUrl}/watchlist`);
    expect(built.html).toContain(common.unsubscribeUrl);
  });

  it('lists each keyword in the plain-text fallback', () => {
    expect(built.text).toContain('small mover');
    expect(built.text).toContain('big mover');
    expect(built.text).toContain('no prior');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/notifications/digest/buildDigestEmail.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Implement the builder**

```ts
// lib/notifications/digest/buildDigestEmail.ts
/**
 * Pure builder for the weekly digest email. Mirrors buildImportEmail.ts:
 * no network, returns { subject, text, html } so it can be snapshot/unit
 * tested. The caller passes a fully-signed unsubscribeUrl and (for the
 * watchlist variant) rows already sorted biggest-mover-first.
 *
 * See docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md §7.
 */
import type { BuiltEmail, DigestKeywordRow } from './types';

interface CommonInput {
  weekEndDate: string;
  appUrl: string;
  unsubscribeUrl: string;   // already token-signed by the caller
}
interface BroadcastInput extends CommonInput { variant: 'broadcast'; }
interface WatchlistInput extends CommonInput {
  variant: 'watchlist';
  rows: DigestKeywordRow[];   // already sorted biggest-mover-first
}

const GREEN = '#15803d';
const RED = '#b91c1c';
const GRAY = '#6b7280';

export function buildDigestEmail(input: BroadcastInput | WatchlistInput): BuiltEmail {
  return input.variant === 'broadcast' ? buildBroadcast(input) : buildWatchlist(input);
}

function buildBroadcast(i: BroadcastInput): BuiltEmail {
  const subject = 'Amazon Keywords Updated! Explore new week of keyword changes';
  const exploreUrl = `${i.appUrl}/explorer`;
  const text = [
    'Amazon Keywords Updated',
    '',
    `The week of ${i.weekEndDate} is now live. Fresh ranks, deltas, and volume estimates are ready to explore.`,
    '',
    `Explore the keyword data: ${exploreUrl}`,
    '',
    '—',
    `You're receiving this weekly digest because you have an account.`,
    `Unsubscribe: ${i.unsubscribeUrl}`,
  ].join('\n');

  const html = shell(
    `
    <h1 style="margin:0 0 12px 0;font-size:20px;color:#111;">Amazon Keywords Updated</h1>
    <p style="margin:0 0 20px 0;color:#333;font-size:14px;">
      The week of <strong>${escapeHtml(i.weekEndDate)}</strong> is now live. Fresh ranks,
      deltas, and volume estimates are ready to explore.
    </p>
    ${ctaButton(exploreUrl, 'Explore the keyword data →')}
    `,
    i.unsubscribeUrl,
    `You're receiving this weekly digest because you have an account.`,
  );

  return { subject, text, html };
}

function buildWatchlist(i: WatchlistInput): BuiltEmail {
  const subject = 'Amazon Keywords Updated! See what changed in your Watchlist and explore today!';
  const watchlistUrl = `${i.appUrl}/watchlist`;

  const textRows = i.rows.map((r) => {
    if (r.currentRank === null) {
      return `${r.searchTermRaw} — not ranked this week (prior ${fmtNum(r.priorWeekRank)})`;
    }
    return `${r.searchTermRaw} — rank ${fmtNum(r.currentRank)} (prior ${fmtNum(r.priorWeekRank)}, 4w ${fmtNum(r.rank4wAgo)}, Δ ${fmtDeltaText(r.improvement1w)}), est vol ${fmtVol(r.estMonthlyVolume)}`;
  });
  const text = [
    'Amazon Keywords Updated',
    '',
    `The week of ${i.weekEndDate} is live. Here's how your ${i.rows.length} watched keywords moved this week — biggest movers first:`,
    '',
    ...textRows,
    '',
    `Open your watchlist: ${watchlistUrl}`,
    '',
    '—',
    `You're receiving this because you watch keywords on Amazon Analytics.`,
    `Unsubscribe: ${i.unsubscribeUrl}`,
  ].join('\n');

  const tableRows = i.rows.map((r) => rowHtml(r, i.appUrl)).join('');
  const html = shell(
    `
    <h1 style="margin:0 0 12px 0;font-size:20px;color:#111;">Amazon Keywords Updated</h1>
    <p style="margin:0 0 16px 0;color:#333;font-size:14px;">
      The week of <strong>${escapeHtml(i.weekEndDate)}</strong> is live. Here's how your
      <strong>${i.rows.length}</strong> watched keywords moved this week — biggest movers first:
    </p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:#555;border-bottom:1px solid #e5e7eb;">
          <th style="padding:6px 8px 6px 0;">Keyword</th>
          <th style="padding:6px 8px;text-align:right;">Rank</th>
          <th style="padding:6px 8px;text-align:right;">Prior</th>
          <th style="padding:6px 8px;text-align:right;">4w</th>
          <th style="padding:6px 8px;text-align:right;">Δ 1w</th>
          <th style="padding:6px 0 6px 8px;text-align:right;">Est. vol</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div style="margin-top:20px;">${ctaButton(watchlistUrl, 'Open your watchlist →')}</div>
    `,
    i.unsubscribeUrl,
    `You're receiving this because you watch keywords on Amazon Analytics.`,
  );

  return { subject, text, html };
}

function rowHtml(r: DigestKeywordRow, appUrl: string): string {
  const link = `${appUrl}/explorer/keyword/${encodeURIComponent(r.searchTermId)}`;
  const name = `<a href="${link}" style="color:#2563eb;text-decoration:none;">${escapeHtml(r.searchTermRaw)}</a>`;
  if (r.currentRank === null) {
    return `
      <tr style="border-bottom:1px solid #f3f4f6;color:#9ca3af;">
        <td style="padding:6px 8px 6px 0;">${name}<br><span style="font-size:11px;">not ranked this week</span></td>
        <td style="padding:6px 8px;text-align:right;">—</td>
        <td style="padding:6px 8px;text-align:right;">${fmtNum(r.priorWeekRank)}</td>
        <td style="padding:6px 8px;text-align:right;">${fmtNum(r.rank4wAgo)}</td>
        <td style="padding:6px 8px;text-align:right;">—</td>
        <td style="padding:6px 0 6px 8px;text-align:right;">—</td>
      </tr>`;
  }
  return `
    <tr style="border-bottom:1px solid #f3f4f6;color:#111;">
      <td style="padding:6px 8px 6px 0;">${name}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(r.currentRank)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${fmtNum(r.priorWeekRank)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${fmtNum(r.rank4wAgo)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${deltaHtml(r.improvement1w)}</td>
      <td style="padding:6px 0 6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtVol(r.estMonthlyVolume)}</td>
    </tr>`;
}

function deltaHtml(improvement: number | null): string {
  if (improvement === null) return `<span style="color:${GRAY};">—</span>`;
  if (improvement === 0) return `<span style="color:${GRAY};">0</span>`;
  const color = improvement > 0 ? GREEN : RED;
  const sign = improvement > 0 ? '+' : '−';
  return `<span style="color:${color};">${sign}${fmtNum(Math.abs(improvement))}</span>`;
}

function fmtDeltaText(improvement: number | null): string {
  if (improvement === null) return '—';
  if (improvement === 0) return '0';
  return `${improvement > 0 ? '+' : '−'}${fmtNum(Math.abs(improvement))}`;
}

function fmtNum(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/** Compact volume: 1.2M / 423K / 1,234 — matches the explorer table. */
function fmtVol(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

function ctaButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">${escapeHtml(label)}</a>`;
}

function shell(bodyHtml: string, unsubscribeUrl: string, footerReason: string): string {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;">
  ${bodyHtml}
  <hr style="margin:28px 0 12px 0;border:none;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">
    ${escapeHtml(footerReason)}<br>
    <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
  </p>
</div>`.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/notifications/digest/buildDigestEmail.test.ts`
Expected: PASS. (If the green/red regex assertions fail, confirm the hex constants `#15803d` / `#b91c1c` and the `+`/`−` sign rendering match the test's expectations exactly.)

- [ ] **Step 5: Commit Phase 2**

```bash
git add lib/notifications/digest/
git commit -m "$(cat <<'EOF'
feat(digest): pure core — types, unsub token, helpers, email builder

- types.ts: shared DigestRecipient / DigestKeywordRow / BuiltEmail
- unsubToken.ts: HMAC sign/verify (signed userId, no expiry) + tests
- recipients.ts: variantFor / chunk / rollupRunStatus + tests
- buildDigestEmail.ts: broadcast + watchlist variants, Δ colors,
  not-ranked rows, plain-text fallback, unsubscribe footer + tests

Weekly digest, Phase 2 (TDD).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Data loaders (~1.5h)

### Task 3.1 — `groupAndSortWatchlistRows` pure transform

**Files:**
- Create: `lib/notifications/digest/loadDigestData.ts` (transform first; queries added in Task 3.2)
- Create: `lib/notifications/digest/loadDigestData.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/notifications/digest/loadDigestData.test.ts`
Expected: FAIL — module/exports not defined.

- [ ] **Step 3: Write the transform + the row type (queries come in Task 3.2)**

Start the file with ONLY the imports the pure transform needs. The DB
imports are added in Task 3.2 when the query functions land — adding them
now would leave unused imports that fail lint.

```ts
// lib/notifications/digest/loadDigestData.ts
import 'server-only';
import type { DigestKeywordRow } from './types';

/** Raw shape returned by the watchlist-rows query (pre-grouping). */
export interface RawWatchlistRow extends DigestKeywordRow {
  userId: string;
}

/**
 * Group raw (user, keyword) rows by user and sort each user's list
 * biggest-mover-first: |improvement1w| desc, nulls last, ties broken by
 * current rank asc. Pure — unit tested directly.
 */
export function groupAndSortWatchlistRows(
  rows: RawWatchlistRow[],
): Map<string, DigestKeywordRow[]> {
  const byUser = new Map<string, DigestKeywordRow[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({
      searchTermId: r.searchTermId,
      searchTermRaw: r.searchTermRaw,
      currentRank: r.currentRank,
      priorWeekRank: r.priorWeekRank,
      rank4wAgo: r.rank4wAgo,
      improvement1w: r.improvement1w,
      estMonthlyVolume: r.estMonthlyVolume,
    });
    byUser.set(r.userId, list);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => {
      const aNull = a.improvement1w === null;
      const bNull = b.improvement1w === null;
      if (aNull && bNull) return rankAsc(a, b);
      if (aNull) return 1;   // nulls last
      if (bNull) return -1;
      const diff = Math.abs(b.improvement1w as number) - Math.abs(a.improvement1w as number);
      if (diff !== 0) return diff;
      return rankAsc(a, b);
    });
  }
  return byUser;
}

function rankAsc(a: DigestKeywordRow, b: DigestKeywordRow): number {
  const ar = a.currentRank ?? Number.POSITIVE_INFINITY;
  const br = b.currentRank ?? Number.POSITIVE_INFINITY;
  return ar - br;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/notifications/digest/loadDigestData.test.ts`
Expected: PASS (5 tests).

### Task 3.2 — The three DB loaders

**Files:**
- Modify: `lib/notifications/digest/loadDigestData.ts` (append the query functions)

- [ ] **Step 1: Append the loaders**

First, add the DB imports just below the existing `import type { DigestKeywordRow }` line at the top of `lib/notifications/digest/loadDigestData.ts`:

```ts
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, watchlistItems, searchTerms, keywordCurrentSummary, weeklyDigestSends } from '@/db/schema';
import type { DigestRecipient } from './types';
```

Then add to the bottom of the file:

```ts
/**
 * All subscribed users with an email, plus their watchlist count (which
 * selects the variant). When `onlyFailedForWeek` is set, restrict to
 * users with a failed send row for that week (retry mode).
 */
export async function loadEligibleRecipients(
  opts?: { onlyFailedForWeek?: string },
): Promise<DigestRecipient[]> {
  const failedSubquery = opts?.onlyFailedForWeek
    ? inArray(
        users.id,
        db
          .select({ id: weeklyDigestSends.userId })
          .from(weeklyDigestSends)
          .where(
            and(
              eq(weeklyDigestSends.weekEndDate, opts.onlyFailedForWeek),
              eq(weeklyDigestSends.status, 'failed'),
            ),
          ),
      )
    : undefined;

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      watchlistCount: sql<number>`COUNT(${watchlistItems.keywordId})::int`,
    })
    .from(users)
    .leftJoin(watchlistItems, eq(watchlistItems.userId, users.id))
    .where(and(isNotNull(users.email), eq(users.weeklyDigestSubscribed, true), failedSubquery))
    .groupBy(users.id, users.email);

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    watchlistCount: r.watchlistCount,
  }));
}

/**
 * Current-week metrics for every keyword watched by the given users,
 * grouped per user and sorted biggest-mover-first. LEFT JOIN to kcs so a
 * keyword that fell out of this week's rankings still returns (with null
 * metrics → "not ranked this week" in the email).
 */
export async function loadWatchlistRowsByUser(
  userIds: string[],
): Promise<Map<string, DigestKeywordRow[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: watchlistItems.userId,
      searchTermId: searchTerms.id,
      searchTermRaw: searchTerms.searchTermRaw,
      currentRank: keywordCurrentSummary.currentRank,
      priorWeekRank: keywordCurrentSummary.priorWeekRank,
      rank4wAgo: keywordCurrentSummary.rank4wAgo,
      improvement1w: keywordCurrentSummary.improvement1w,
      estMonthlyVolume: keywordCurrentSummary.estimatedMonthlyVolumeCurrent,
    })
    .from(watchlistItems)
    .innerJoin(searchTerms, eq(searchTerms.id, watchlistItems.keywordId))
    .leftJoin(keywordCurrentSummary, eq(keywordCurrentSummary.searchTermId, watchlistItems.keywordId))
    .where(inArray(watchlistItems.userId, userIds));

  return groupAndSortWatchlistRows(rows as RawWatchlistRow[]);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Drizzle types the LEFT-JOINed kcs columns as nullable, matching `DigestKeywordRow`.)

- [ ] **Step 3: Re-run the transform tests (no regression)**

Run: `npm test -- lib/notifications/digest/loadDigestData.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit Phase 3**

```bash
git add lib/notifications/digest/loadDigestData.ts lib/notifications/digest/loadDigestData.test.ts
git commit -m "$(cat <<'EOF'
feat(digest): data loaders + grouping transform

groupAndSortWatchlistRows (pure, tested): group by user, sort biggest-
mover-first with nulls last and current-rank tie-break. loadEligible
Recipients (+ retry-mode filter) and loadWatchlistRowsByUser query
builders feeding it.

Weekly digest, Phase 3.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Send engine + Inngest function (~2h)

### Task 4.1 — `sendWeeklyDigest` orchestration

**Files:**
- Create: `lib/notifications/digest/sendWeeklyDigest.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// lib/notifications/digest/sendWeeklyDigest.ts
import 'server-only';
import { Resend } from 'resend';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { weeklyDigestRuns, weeklyDigestSends } from '@/db/schema';
import { loadEligibleRecipients, loadWatchlistRowsByUser } from './loadDigestData';
import { buildDigestEmail } from './buildDigestEmail';
import { signUnsubToken } from './unsubToken';
import { variantFor, chunk, rollupRunStatus } from './recipients';
import type { DigestRecipient, DigestKeywordRow } from './types';

const CHUNK_SIZE = 100;        // Resend batch maximum
const STALE_SENDING_MS = 15 * 60 * 1000;

export interface SendDigestResult {
  skipped?: 'already_sent' | 'not_recoverable';
  weekEndDate: string;
  recipients: number;
  sent: number;
  failed: number;
  status: string;
}

/**
 * Send (or retry) the weekly digest for `weekEndDate`. Idempotent at the
 * (week, user) grain. See spec §8.
 */
export async function sendWeeklyDigest(opts: {
  weekEndDate: string;
  triggeredBy?: string | null;
  retry?: boolean;
}): Promise<SendDigestResult> {
  const { weekEndDate, triggeredBy = null, retry = false } = opts;

  // 1. Idempotency gate.
  if (!retry) {
    const inserted = await db
      .insert(weeklyDigestRuns)
      .values({ weekEndDate, status: 'sending', triggeredBy })
      .onConflictDoNothing()
      .returning({ weekEndDate: weeklyDigestRuns.weekEndDate });
    if (inserted.length === 0) {
      return { skipped: 'already_sent', weekEndDate, recipients: 0, sent: 0, failed: 0, status: 'already_sent' };
    }
  } else {
    // Retry mode: only proceed if the existing row is recoverable
    // (sent_with_failures, or a stale 'sending' run that crashed past
    // Inngest's own retries). Flip it back to 'sending'.
    const staleCutoff = new Date(Date.now() - STALE_SENDING_MS);
    const updated = await db
      .update(weeklyDigestRuns)
      .set({ status: 'sending', finishedAt: null })
      .where(
        and(
          eq(weeklyDigestRuns.weekEndDate, weekEndDate),
          sql`(${weeklyDigestRuns.status} = 'sent_with_failures'
               OR (${weeklyDigestRuns.status} = 'sending' AND ${weeklyDigestRuns.startedAt} < ${staleCutoff}))`,
        ),
      )
      .returning({ weekEndDate: weeklyDigestRuns.weekEndDate });
    if (updated.length === 0) {
      return { skipped: 'not_recoverable', weekEndDate, recipients: 0, sent: 0, failed: 0, status: 'not_recoverable' };
    }
  }

  // 2. Load recipients (retry restricts to previously-failed users).
  const recipients = await loadEligibleRecipients(
    retry ? { onlyFailedForWeek: weekEndDate } : undefined,
  );

  // 3. Seed pending send rows (idempotent — skips users already sent).
  if (recipients.length > 0) {
    await db
      .insert(weeklyDigestSends)
      .values(
        recipients.map((r) => ({
          weekEndDate,
          userId: r.userId,
          variant: variantFor(r.watchlistCount),
          status: 'pending' as const,
        })),
      )
      .onConflictDoNothing();
  }

  // 4. Load watchlist rows for watchlist-variant users.
  const watchlistUserIds = recipients.filter((r) => r.watchlistCount > 0).map((r) => r.userId);
  const rowsByUser = await loadWatchlistRowsByUser(watchlistUserIds);

  // 5. Fan out in chunks.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';

  let sent = 0;
  let failed = 0;

  if (!apiKey) {
    // Fail-soft: local dev without Resend. Leave rows 'pending', finish.
    console.warn(`[sendWeeklyDigest] RESEND_API_KEY not set — skipping send for ${weekEndDate}.`);
  } else {
    const resend = new Resend(apiKey);
    for (const group of chunk(recipients, CHUNK_SIZE)) {
      const payloads = group.map((r) => buildEmailPayload(r, weekEndDate, appUrl, from, rowsByUser));
      try {
        const { data, error } = await resend.batch.send(payloads);
        if (error) {
          await markChunk(group, weekEndDate, 'failed', null, error.message ?? 'batch error');
          failed += group.length;
        } else {
          const ids = data?.data ?? [];
          for (let idx = 0; idx < group.length; idx++) {
            await markOne(group[idx], weekEndDate, 'sent', ids[idx]?.id ?? null, null);
          }
          sent += group.length;
        }
      } catch (e) {
        await markChunk(group, weekEndDate, 'failed', null, e instanceof Error ? e.message : 'send threw');
        failed += group.length;
      }
    }
  }

  // 6. Roll up the run row.
  const status = apiKey ? rollupRunStatus({ sent, failed }) : 'sent';
  await db
    .update(weeklyDigestRuns)
    .set({
      status,
      finishedAt: new Date(),
      recipientsCount: recipients.length,
      sentCount: sent,
      failedCount: failed,
    })
    .where(eq(weeklyDigestRuns.weekEndDate, weekEndDate));

  return { weekEndDate, recipients: recipients.length, sent, failed, status };
}

/** Build one Resend batch entry (email object) for a recipient. */
function buildEmailPayload(
  r: DigestRecipient,
  weekEndDate: string,
  appUrl: string,
  from: string,
  rowsByUser: Map<string, DigestKeywordRow[]>,
) {
  const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?token=${signUnsubToken(r.userId)}`;
  const built =
    r.watchlistCount > 0
      ? buildDigestEmail({
          variant: 'watchlist',
          weekEndDate,
          appUrl,
          unsubscribeUrl,
          rows: rowsByUser.get(r.userId) ?? [],
        })
      : buildDigestEmail({ variant: 'broadcast', weekEndDate, appUrl, unsubscribeUrl });

  return {
    from,
    to: [r.email],
    subject: built.subject,
    html: built.html,
    text: built.text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

async function markOne(
  r: DigestRecipient,
  weekEndDate: string,
  status: 'sent' | 'failed',
  resendId: string | null,
  error: string | null,
) {
  await db
    .update(weeklyDigestSends)
    .set({ status, resendId, error: error?.slice(0, 1000) ?? null, sentAt: status === 'sent' ? new Date() : null })
    .where(and(eq(weeklyDigestSends.weekEndDate, weekEndDate), eq(weeklyDigestSends.userId, r.userId)));
}

async function markChunk(
  group: DigestRecipient[],
  weekEndDate: string,
  status: 'sent' | 'failed',
  resendId: string | null,
  error: string | null,
) {
  for (const r of group) {
    await markOne(r, weekEndDate, status, resendId, error);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If the Resend SDK's `batch.send` types differ, confirm the installed `resend` version exposes `resend.batch.send(payloads)` returning `{ data: { data: { id }[] }, error }`. Adjust the `data?.data` access to match the installed type if necessary.)

### Task 4.2 — Inngest function + registration

**Files:**
- Create: `inngest/functions/sendWeeklyDigest.ts`
- Modify: `inngest/functions/index.ts`

- [ ] **Step 1: Write the Inngest function**

```ts
// inngest/functions/sendWeeklyDigest.ts
/**
 * Weekly digest fan-out. Triggered by the admin "Send digest" button via
 * the `digest.send-weekly` event. The heavy lifting (idempotency gate,
 * chunked Resend batch, per-user status rows) is in
 * lib/notifications/digest/sendWeeklyDigest.ts; this wrapper just invokes
 * it inside a single step so Inngest's retry re-invokes safely (sends are
 * idempotent at the (week, user) grain).
 *
 * Event payload: { weekEndDate: string; triggeredBy?: string; retry?: boolean }
 */
import { inngest } from '../client';
import { sendWeeklyDigest } from '@/lib/notifications/digest/sendWeeklyDigest';

export const sendWeeklyDigestFn = inngest.createFunction(
  {
    id: 'send-weekly-digest',
    name: 'Send weekly digest',
    concurrency: { limit: 1, key: 'event.data.weekEndDate' },
    retries: 2,
  },
  { event: 'digest.send-weekly' },
  async ({ event, step }) => {
    const { weekEndDate, triggeredBy, retry } = event.data as {
      weekEndDate: string;
      triggeredBy?: string;
      retry?: boolean;
    };
    return step.run('send', () =>
      sendWeeklyDigest({ weekEndDate, triggeredBy: triggeredBy ?? null, retry: retry ?? false }),
    );
  },
);
```

- [ ] **Step 2: Register the function**

In `inngest/functions/index.ts`, add the import and array entry:
```ts
import { sendWeeklyDigestFn } from './sendWeeklyDigest';
```
```ts
export const functions = [
  rubricUploadedFn,
  validateFileFn,
  importBatchFn,
  enrichKeepaForWeek,
  processMonthlySfr,
  processCalibrationUpload,
  syncKcsKeepaAggregates,
  sendWeeklyDigestFn,
];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit Phase 4**

```bash
git add lib/notifications/digest/sendWeeklyDigest.ts inngest/functions/sendWeeklyDigest.ts inngest/functions/index.ts
git commit -m "$(cat <<'EOF'
feat(digest): send engine + Inngest function

sendWeeklyDigest: idempotency gate (insert-or-recover), seed pending
(week,user) rows, chunked Resend batch send (100/chunk) with per-user
status + List-Unsubscribe headers, run-level rollup. Fail-soft when
RESEND_API_KEY is unset. Wrapped by the digest.send-weekly Inngest fn.

Weekly digest, Phase 4.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Admin page + send route + preview (~2h)

### Task 5.1 — Weeks-list loader for the page

**Files:**
- Modify: `lib/notifications/digest/loadDigestData.ts` (append)

- [ ] **Step 1: Append the page loader**

```ts
/** A row for the /admin/digests table: a completed week + its digest run (if any). */
export interface DigestWeekRow {
  weekEndDate: string;
  isCurrent: boolean;
  runStatus: string | null;        // null = "Not sent"
  recipientsCount: number | null;
  sentCount: number | null;
  failedCount: number | null;
}

/**
 * Recent completed weeks joined to their digest run, plus which week is
 * the current snapshot (the only sendable one).
 */
export async function loadDigestWeeks(limit = 12): Promise<DigestWeekRow[]> {
  const [meta] = await db
    .select({ current: keywordCurrentSummaryMeta.currentWeekEndDate })
    .from(keywordCurrentSummaryMeta)
    .limit(1);
  const currentWeek = meta?.current ?? null;

  const weeks = await db
    .select({
      weekEndDate: reportingWeeks.weekEndDate,
      runStatus: weeklyDigestRuns.status,
      recipientsCount: weeklyDigestRuns.recipientsCount,
      sentCount: weeklyDigestRuns.sentCount,
      failedCount: weeklyDigestRuns.failedCount,
    })
    .from(reportingWeeks)
    .leftJoin(weeklyDigestRuns, eq(weeklyDigestRuns.weekEndDate, reportingWeeks.weekEndDate))
    .where(eq(reportingWeeks.isComplete, true))
    .orderBy(desc(reportingWeeks.weekEndDate))
    .limit(limit);

  return weeks.map((w) => ({
    weekEndDate: w.weekEndDate,
    isCurrent: w.weekEndDate === currentWeek,
    runStatus: w.runStatus ?? null,
    recipientsCount: w.recipientsCount ?? null,
    sentCount: w.sentCount ?? null,
    failedCount: w.failedCount ?? null,
  }));
}

/** The current snapshot week (the only sendable one), or null. */
export async function getCurrentDigestWeek(): Promise<string | null> {
  const [meta] = await db
    .select({ current: keywordCurrentSummaryMeta.currentWeekEndDate })
    .from(keywordCurrentSummaryMeta)
    .limit(1);
  return meta?.current ?? null;
}
```

Also, at the top of `loadDigestData.ts`, **replace** the existing `@/db/schema` import line and the existing `drizzle-orm` import line with these supersets (adds `keywordCurrentSummaryMeta`, `reportingWeeks`, `weeklyDigestRuns`, and `desc`):
```ts
import { and, eq, inArray, isNotNull, sql, desc } from 'drizzle-orm';
import { users, watchlistItems, searchTerms, keywordCurrentSummary, keywordCurrentSummaryMeta, reportingWeeks, weeklyDigestRuns, weeklyDigestSends } from '@/db/schema';
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirm `keywordCurrentSummaryMeta` and `reportingWeeks` are exported from `@/db/schema`. If `currentWeekEndDate` is typed as a `Date`, coerce to string with `.toISOString().slice(0,10)` — but it is a `date` column, so drizzle returns a string.)

### Task 5.2 — Admin digests page

**Files:**
- Create: `app/admin/digests/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/admin/digests/page.tsx
import { loadDigestWeeks } from '@/lib/notifications/digest/loadDigestData';
import { SendDigestButton } from './SendDigestButton';

export const dynamic = 'force-dynamic';

export default async function AdminDigestsPage() {
  const weeks = await loadDigestWeeks();
  const currentWeek = weeks.find((w) => w.isCurrent)?.weekEndDate ?? null;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Weekly digests</h1>
      <p className="mt-2 text-gray-600">
        Send the weekly digest email to all subscribed users. Only the{' '}
        <strong>current</strong> week is sendable — its data is what the
        explorer currently shows. Prior weeks are frozen history.
      </p>
      {currentWeek && (
        <p className="mt-1 text-sm text-gray-500">
          Current week: <strong>{currentWeek}</strong>
        </p>
      )}

      <div className="mt-3 flex gap-3 text-sm">
        <a className="text-blue-700 underline" href="/admin/digests/preview?variant=watchlist" target="_blank" rel="noreferrer">
          Preview watchlist variant ▸
        </a>
        <a className="text-blue-700 underline" href="/admin/digests/preview?variant=broadcast" target="_blank" rel="noreferrer">
          Preview broadcast variant ▸
        </a>
      </div>

      <div className="mt-6 overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
            <tr>
              <th className="p-2">Week</th>
              <th className="p-2">Refresh</th>
              <th className="p-2">Digest status</th>
              <th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {weeks.map((w) => (
              <tr key={w.weekEndDate} className={w.isCurrent ? 'bg-blue-50/40' : ''}>
                <td className="p-2 font-mono">{w.weekEndDate}</td>
                <td className="p-2 text-gray-600">{w.isCurrent ? '✓ current' : '✓ complete'}</td>
                <td className="p-2">{digestStatusLabel(w.runStatus, w.recipientsCount, w.sentCount, w.failedCount)}</td>
                <td className="p-2">
                  {w.isCurrent ? (
                    <SendDigestButton weekEndDate={w.weekEndDate} runStatus={w.runStatus} />
                  ) : (
                    <span className="text-xs text-gray-400">data not current</span>
                  )}
                </td>
              </tr>
            ))}
            {weeks.length === 0 && (
              <tr><td colSpan={4} className="p-3 text-center text-gray-500">No completed weeks yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function digestStatusLabel(
  status: string | null,
  recipients: number | null,
  sent: number | null,
  failed: number | null,
): React.ReactNode {
  if (!status) return <span className="text-gray-500">Not sent</span>;
  if (status === 'sending') return <span className="text-blue-700">Sending…</span>;
  if (status === 'sent') return <span className="text-green-700">Sent · {sent ?? recipients ?? 0} recipients</span>;
  if (status === 'sent_with_failures') return <span className="text-amber-700">Sent · {sent ?? 0} ({failed ?? 0} failed)</span>;
  if (status === 'failed') return <span className="text-red-700">Failed</span>;
  return <span className="text-gray-500">{status}</span>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (SendDigestButton resolves after Task 5.3 — do Task 5.3 before this typecheck, or expect a transient missing-module error until then).

### Task 5.3 — Send button (client)

**Files:**
- Create: `app/admin/digests/SendDigestButton.tsx`

- [ ] **Step 1: Write the client button**

```tsx
// app/admin/digests/SendDigestButton.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'idle' | 'firing' | 'sent' | 'failed';

/**
 * Send / Retry / Resume button for the current week's digest. Mirrors
 * KeepaEnrichmentButton's idle/firing/sent/failed pattern. The label +
 * confirm copy depend on the current run status:
 *   - null / undefined        → "Send digest"
 *   - 'sent_with_failures'     → "Retry failures"
 *   - 'sending' (stale)        → "Resume send" (retry mode)
 * 'sent' shows nothing (already done).
 */
export function SendDigestButton({
  weekEndDate,
  runStatus,
}: {
  weekEndDate: string;
  runStatus: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  if (runStatus === 'sent') {
    return <span className="text-xs text-gray-400">—</span>;
  }

  const isRetry = runStatus === 'sent_with_failures' || runStatus === 'sending';
  const label =
    runStatus === 'sent_with_failures' ? 'Retry failures'
    : runStatus === 'sending' ? 'Resume send'
    : 'Send digest';

  async function fire() {
    const confirmMsg =
      `Send the weekly digest for ${weekEndDate} to all subscribed users? ` +
      `This emails everyone subscribed and can't be unsent.`;
    if (!confirm(confirmMsg)) return;
    setError(null);
    setPhase('firing');
    try {
      const res = await fetch('/api/admin/digests/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weekEndDate, retry: isRetry }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPhase('sent');
      // Give the run row a moment to flip to 'sending', then refresh.
      router.refresh();
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : 'unknown error');
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={fire}
        disabled={phase === 'firing' || phase === 'sent'}
        className="self-start rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {phase === 'firing' ? 'Firing…' : phase === 'sent' ? 'Queued ✓' : label}
      </button>
      {phase === 'sent' && (
        <p className="text-xs text-gray-600">Refresh in a moment to see the result.</p>
      )}
      {phase === 'failed' && error && <p className="text-xs text-red-700">Failed: {error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the send route resolves after Task 5.4; the fetch URL is a string so this typechecks now).

### Task 5.4 — Send API route

**Files:**
- Create: `app/api/admin/digests/send/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/admin/digests/send/route.ts
/**
 * Admin endpoint: fire the weekly digest for the CURRENT snapshot week.
 * Validates that the requested week equals the current kcs week (the
 * only sendable one), then fires the `digest.send-weekly` Inngest event.
 *
 * Body: { weekEndDate: string; retry?: boolean }
 * Response: { ok: true, eventId, weekEndDate } | { error } (4xx)
 */
import { NextResponse } from 'next/server';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { inngest } from '@/inngest/client';
import { getCurrentDigestWeek } from '@/lib/notifications/digest/loadDigestData';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let user;
  try {
    await requireAdmin();
    user = await getCurrentUser();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as { weekEndDate?: unknown; retry?: unknown };
  if (typeof body.weekEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.weekEndDate)) {
    return NextResponse.json({ error: 'weekEndDate must be YYYY-MM-DD' }, { status: 400 });
  }

  // Enforce "current week only".
  const currentWeek = await getCurrentDigestWeek();
  if (!currentWeek) {
    return NextResponse.json({ error: 'no current week available' }, { status: 409 });
  }
  if (body.weekEndDate !== currentWeek) {
    return NextResponse.json(
      { error: `only the current week (${currentWeek}) can be sent` },
      { status: 409 },
    );
  }

  const result = await inngest.send({
    name: 'digest.send-weekly',
    data: {
      weekEndDate: body.weekEndDate,
      triggeredBy: user?.id ?? null,
      retry: body.retry === true,
    },
  });

  return NextResponse.json({
    ok: true,
    eventId: result.ids?.[0] ?? null,
    weekEndDate: body.weekEndDate,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirm `getCurrentUser` is exported from `@/lib/auth/getCurrentUser` — it is used by the detail page and explorer.)

### Task 5.5 — Preview route (non-sending)

**Files:**
- Create: `app/admin/digests/preview/page.tsx`

- [ ] **Step 1: Write the preview page**

```tsx
// app/admin/digests/preview/page.tsx
/**
 * Non-sending browser preview of the digest email. Renders the actual
 * email HTML for the current week. ?variant=watchlist uses the admin's
 * own watched keywords (falling back to a sample set if they watch none);
 * ?variant=broadcast renders the broadcast variant.
 */
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { buildDigestEmail } from '@/lib/notifications/digest/buildDigestEmail';
import { signUnsubToken } from '@/lib/notifications/digest/unsubToken';
import { loadWatchlistRowsByUser, getCurrentDigestWeek } from '@/lib/notifications/digest/loadDigestData';
import type { DigestKeywordRow } from '@/lib/notifications/digest/types';

export const dynamic = 'force-dynamic';

const SAMPLE_ROWS: DigestKeywordRow[] = [
  { searchTermId: 'sample-1', searchTermRaw: 'wireless earbuds', currentRank: 1204, priorWeekRank: 1520, rank4wAgo: 2100, improvement1w: 316, estMonthlyVolume: 45000 },
  { searchTermId: 'sample-2', searchTermRaw: 'airpods case', currentRank: 8910, priorWeekRank: 7200, rank4wAgo: 6800, improvement1w: -1710, estMonthlyVolume: 12000 },
  { searchTermId: 'sample-3', searchTermRaw: 'usb c cable', currentRank: null, priorWeekRank: 4000, rank4wAgo: 3900, improvement1w: null, estMonthlyVolume: null },
];

export default async function DigestPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const { variant } = await searchParams;
  const user = await requireAuthenticatedUser();
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';
  const weekEndDate = (await getCurrentDigestWeek()) ?? '2026-01-01';
  const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?token=${signUnsubToken(user.id)}`;

  let html: string;
  if (variant === 'broadcast') {
    html = buildDigestEmail({ variant: 'broadcast', weekEndDate, appUrl, unsubscribeUrl }).html;
  } else {
    const rowsByUser = await loadWatchlistRowsByUser([user.id]);
    const rows = rowsByUser.get(user.id) ?? [];
    html = buildDigestEmail({
      variant: 'watchlist',
      weekEndDate,
      appUrl,
      unsubscribeUrl,
      rows: rows.length > 0 ? rows : SAMPLE_ROWS,
    }).html;
  }

  return (
    <div>
      <p style={{ fontFamily: 'sans-serif', fontSize: 12, color: '#666', marginBottom: 16 }}>
        Preview — variant: <strong>{variant === 'broadcast' ? 'broadcast' : 'watchlist'}</strong>, week: <strong>{weekEndDate}</strong>. No email sent.
      </p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

### Task 5.6 — Admin nav link

**Files:**
- Modify: `app/admin/layout.tsx`

- [ ] **Step 1: Add the nav link**

In `app/admin/layout.tsx`, add after the Keepa enrichment link (line 42):
```tsx
          <Link href="/admin/keepa-enrichment" className="hover:underline">
            Keepa enrichment
          </Link>
          <Link href="/admin/digests" className="hover:underline">
            Weekly digests
          </Link>
```

- [ ] **Step 2: Typecheck + commit Phase 5**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add app/admin/digests app/api/admin/digests app/admin/layout.tsx lib/notifications/digest/loadDigestData.ts
git commit -m "$(cat <<'EOF'
feat(digest): admin page + send route + browser preview

/admin/digests lists recent weeks with digest status; Send/Retry/Resume
on the current week only (data-not-current on prior weeks). Send route
enforces current-week-only and fires the Inngest event. Non-sending
/admin/digests/preview renders both variants. Nav link added.

Weekly digest, Phase 5.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Unsubscribe / re-subscribe (~45 min)

### Task 6.1 — Unsubscribe route (GET + POST)

**Files:**
- Create: `app/api/notifications/unsubscribe/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/notifications/unsubscribe/route.ts
/**
 * One-click unsubscribe (GET) + re-subscribe (POST) for the weekly digest.
 *
 * GET ?token=…  → verify HMAC → set weekly_digest_subscribed=false →
 *                 return a confirmation HTML page with a re-subscribe form.
 * POST (token in body) → verify → set weekly_digest_subscribed=true →
 *                 return the same page reading "re-subscribed".
 *
 * Public (no auth) — recipients click straight from an email. The signed
 * token is the authorization. See spec §11.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { verifyUnsubToken } from '@/lib/notifications/digest/unsubToken';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const verified = verifyUnsubToken(token);
  if (!verified) return htmlResponse(invalidPage(), 400);

  try {
    await db.update(users).set({ weeklyDigestSubscribed: false }).where(eq(users.id, verified.userId));
  } catch (e) {
    console.error('[unsubscribe] db update failed:', e);
    return htmlResponse(errorPage(), 500);
  }
  return htmlResponse(unsubscribedPage(token), 200);
}

export async function POST(req: Request) {
  // Token may arrive as form-encoded (from the re-subscribe form) or JSON.
  let token = '';
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    token = body.token ?? '';
  } else {
    const form = await req.formData().catch(() => null);
    token = (form?.get('token') as string) ?? '';
  }

  const verified = verifyUnsubToken(token);
  if (!verified) return htmlResponse(invalidPage(), 400);

  try {
    await db.update(users).set({ weeklyDigestSubscribed: true }).where(eq(users.id, verified.userId));
  } catch (e) {
    console.error('[resubscribe] db update failed:', e);
    return htmlResponse(errorPage(), 500);
  }
  return htmlResponse(resubscribedPage(), 200);
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function page(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:48px auto;padding:24px;color:#111;">
${inner}
</body></html>`;
}

function unsubscribedPage(token: string): string {
  return page(`
    <h1 style="font-size:20px;">You've been unsubscribed</h1>
    <p style="color:#444;">You'll no longer receive the weekly digest email.</p>
    <p style="color:#444;">Changed your mind?</p>
    <form method="post" action="/api/notifications/unsubscribe">
      <input type="hidden" name="token" value="${escapeAttr(token)}">
      <button type="submit" style="background:#2563eb;color:#fff;border:none;padding:10px 16px;border-radius:6px;font-size:14px;cursor:pointer;">Re-subscribe</button>
    </form>
  `);
}

function resubscribedPage(): string {
  return page(`
    <h1 style="font-size:20px;">You're re-subscribed</h1>
    <p style="color:#444;">You'll receive the weekly digest email again.</p>
  `);
}

function invalidPage(): string {
  return page(`
    <h1 style="font-size:20px;">Invalid link</h1>
    <p style="color:#444;">This unsubscribe link is invalid or malformed. If you keep getting emails you don't want, reply to one and we'll sort it out.</p>
  `);
}

function errorPage(): string {
  return page(`
    <h1 style="font-size:20px;">Something went wrong</h1>
    <p style="color:#444;">We couldn't update your preferences just now. Please try again in a minute.</p>
  `);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verify the token round-trip locally**

Run: `npm run dev`. Get a real signed token the easy way: open `/admin/digests/preview?variant=broadcast`, view page source, and copy the `token=` value out of the footer's Unsubscribe link (it's signed for your own admin user).

Visit `http://localhost:3000/api/notifications/unsubscribe?token=<token>` → the confirmation page renders; check in the DB (or `npm run db:studio`) that your user's `weekly_digest_subscribed` is now `false`. Click **Re-subscribe** → confirm it flips back to `true`. Then visit the URL with a deliberately corrupted token (change the last character) → the friendly "Invalid link" page renders with a 400.

- [ ] **Step 4: Commit Phase 6**

```bash
git add app/api/notifications/unsubscribe/route.ts
git commit -m "$(cat <<'EOF'
feat(digest): one-click unsubscribe + re-subscribe

GET verifies the HMAC token and sets weekly_digest_subscribed=false,
returning a confirmation page with a re-subscribe form; POST flips it
back. Public (token is the authorization). Invalid/expired tokens get a
friendly 400 page.

Weekly digest, Phase 6.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — E2E + ship (~45 min)

### Task 7.1 — Environment variable

**Files:**
- Modify: `.env.local` (local, not committed)
- Vercel project env (manual)

- [ ] **Step 1: Add the secret locally**

Add to `.env.local`:
```
DIGEST_UNSUB_SECRET=<a long random string, e.g. output of: openssl rand -base64 32>
```

- [ ] **Step 2: Add it to Vercel**

In the Vercel project settings → Environment Variables, add `DIGEST_UNSUB_SECRET` (Production + Preview) with a strong random value. (Without it, prod falls back to the insecure dev constant and logs a warning — tokens would still work but be forgeable.)

### Task 7.2 — Full test suite + typecheck + lint

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: all digest tests pass (`unsubToken`, `recipients`, `buildDigestEmail`, `loadDigestData`). The pre-existing `inngest/functions/importFile.test.ts` failure is unrelated and out of scope (confirm it's the only failure and it predates this work).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint touched files**

Run:
```bash
npx eslint "lib/notifications/digest" "app/admin/digests" "app/api/admin/digests" "app/api/notifications/unsubscribe" "inngest/functions/sendWeeklyDigest.ts" "db/schema/weeklyDigest.ts"
```
Expected: no errors.

### Task 7.3 — Manual E2E

- [ ] **Step 1: Preview both variants**

`npm run dev`, then:
- Visit `/admin/digests/preview?variant=watchlist` → table renders; if you watch keywords, your real rows show sorted biggest-mover-first with correct Δ colors; otherwise the sample rows render (including the "not ranked this week" row).
- Visit `/admin/digests/preview?variant=broadcast` → the explore CTA renders.

- [ ] **Step 2: Send to a tiny test set**

Ensure only your admin account (and optionally one test account — one with a watchlist, one without) is subscribed (`weekly_digest_subscribed = true`); temporarily set others to false in the DB if your user table is large, OR rely on the small dev user set.

Confirm `RESEND_API_KEY` + `RESEND_FROM` are set in `.env.local`. On `/admin/digests`, click **Send digest** on the current week → confirm dialog → fires. Watch the Inngest dev dashboard (`app.inngest.com` or local) for `send-weekly-digest`. Refresh the page → status shows "Sent · N recipients". Check the inbox(es) — both variants render.

- [ ] **Step 3: Idempotency + retry**

Click **Send** again for the same week (if the button is gone because status='sent', that's correct — the gate worked). To exercise retry, you can manually set the run's status to `sent_with_failures` and one send row to `failed` in the DB, reload, and confirm the button reads "Retry failures" and re-sends only that user.

- [ ] **Step 4: Unsubscribe round-trip**

Click the **Unsubscribe** link in a received email → confirmation page; verify `weekly_digest_subscribed` is now false in the DB. Click **Re-subscribe** → back to true.

### Task 7.4 — Push + verify

- [ ] **Step 1: Push**

Run: `git push`

- [ ] **Step 2: Verify the Vercel deploy**

- Wait for the deploy to finish.
- Confirm `DIGEST_UNSUB_SECRET` is set in Vercel (Task 7.1 Step 2).
- On the deployed app, open `/admin/digests` and the two preview links — confirm they render (no SSR error). This catches any client/server boundary regression like the one Plan 3.4.2 hit.
- Optionally send a real digest for the current week once you've eyeballed the preview.

## Total estimate

~9.5 hours:
- Phase 1: 30 min (schema)
- Phase 2: 2h (pure core, TDD)
- Phase 3: 1.5h (data loaders)
- Phase 4: 2h (send engine + Inngest)
- Phase 5: 2h (admin page + routes + preview)
- Phase 6: 45 min (unsubscribe flow)
- Phase 7: 45 min (E2E + ship)

## Open follow-ups (post-ship)

- **Per-type notification preferences + settings page** — if a second user-facing email type ever ships.
- **Delivery-status webhooks** — capture async bounces/complaints from Resend into `weekly_digest_sends` (today "sent" means "accepted by Resend", not "delivered").
- **Auto-fire on import** — if the manual gate becomes tedious once data quality is trusted.
- **Tab-restore polish for /explorer** (carried over from Plan 3.4.3).
