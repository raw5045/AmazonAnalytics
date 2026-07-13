# Daily Admin Abuse-Digest — Design Spec

**Date:** 2026-07-13
**Status:** Approved (brainstorming complete)
**Owner request:** The report-only safety net for open signup. Since 2026-07-13 anyone can
sign up at keywordquarry.com (Clerk email or one-click Google) with no rate limiter, no
payment gate, and a single admin who isn't watching dashboards. Without monitoring, the
first sign of abuse is a Neon bill, degraded performance, or a Resend quota blowout. This
feature is the *detective* control until the rate limiter (preventive) and payments
(economic) exist: one email every morning summarizing yesterday's activity so abuse is
noticed within ~24 hours.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Read-activity tracking | **Daily counters table** (not full event log, not DB-derived-only) |
| Extra signals | **Both**: Clerk `session.created` → `last_login_at` stamp, and contact-form counters |
| Cadence / quiet days | **Daily, always send** (~7:30am ET), informative subject; missing email = pipeline tripwire |
| Overall shape | **A: Email-only, lean** — no run-history table, no config UI, hardcoded tunable thresholds |

The owner expects to adjust content/thresholds after seeing real emails — thresholds and
email content are isolated in pure modules so those are one-file edits.

## Context facts the design leans on

- `audit_log` exists but has **zero writers**; its `user_id` FK is `ON DELETE RESTRICT`,
  so per-user activity rows there would break user deletion. We do NOT use it.
- `users.last_login_at` exists but is **never set** — the Clerk webhook only handles
  `user.*` events today.
- Signups, watchlist adds, saved views, and custom categories are already derivable from
  `created_at` columns. Explorer queries, detail views, and contact-form activity are
  recorded nowhere.
- All explorer queries funnel through `lib/explorer/runQuery.ts`; detail loads through
  `lib/explorer/fetchKeywordDetail.ts`. Both are invoked from authed server components.
- Reusable plumbing: weekly-digest send patterns (`lib/notifications/digest/`), Resend
  verified domain (`RESEND_FROM`), `isUndeliverableEmail`, Inngest cron functions on the
  Railway worker (`inngest/functions/warmChartSeries.ts` shows the trigger pattern),
  `app_settings` key/value store.

---

## Part 1 — Collection layer

### 1.1 Schema (migration 0043, hand-numbered)

Two counter tables. Migration follows the repo convention: raw SQL file
`db/migrations/0043_activity_daily_counters.sql` applied via
`scripts/applyMigration0043.ts` (mirror `applyMigration0042.ts`), plus Drizzle schema
files so the app can query them.

```sql
CREATE TABLE user_activity_daily (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,                 -- ET calendar date
  metric  varchar(64) NOT NULL,          -- 'explorer_query' | 'detail_view'
  count   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, day, metric)
);
CREATE INDEX user_activity_daily_day_idx ON user_activity_daily (day);

CREATE TABLE app_activity_daily (
  day    date NOT NULL,                  -- ET calendar date
  metric varchar(64) NOT NULL,           -- 'contact_submission' | 'contact_honeypot'
  count  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (day, metric)
);
```

`ON DELETE CASCADE` is deliberate (unlike `audit_log`'s RESTRICT): deleting a user must
never be blocked by their activity counters. `day` is date-typed; the ET day string is
computed app-side. The `day` index supports the digest's day-scoped scans.

Drizzle schema files: `db/schema/userActivityDaily.ts`, `db/schema/appActivityDaily.ts`,
exported from `db/schema/index.ts`.

### 1.2 Bump helpers — `lib/activity/`

- `lib/activity/etDay.ts` — pure `etDay(date: Date): string` returning `YYYY-MM-DD` in
  `America/New_York` via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`.
  DST handled by Intl. Also `previousEtDay(date: Date): string` (the digest's "yesterday").
  Unit-tested including DST boundaries.
- `lib/activity/bump.ts` — `bumpUserActivity(userId: string, metric: UserActivityMetric)`
  and `bumpAppActivity(metric: AppActivityMetric)`. Each is a single upsert:
  `INSERT ... ON CONFLICT (...) DO UPDATE SET count = count + 1`.
  **Fire-and-forget by contract:** callers invoke them un-awaited; internally every error
  is caught and reduced to one `console.warn`. A lost count is acceptable; a slowed or
  crashed request is not. No `import 'server-only'` (same worker-safety rule as the digest
  modules). Metric names are exported union types, not free strings.

### 1.3 Call sites (four)

1. **Explorer page server component** — bump `explorer_query` (un-awaited) alongside each
   `runQuery` execution. Instrumentation lives at the page level, where the authed user
   already exists; `lib/explorer/*` stays pure. Every executed query counts (filter
   changes, pagination, saved-view loads) — each is a real DB query.
2. **Keyword detail page** — bump `detail_view` alongside `fetchKeywordDetail`, same
   pattern.
3. **`app/api/contact/route.ts`** — bump `contact_submission` when a real send succeeds;
   bump `contact_honeypot` when the honeypot trips (before the silent-success return).
   Malformed 400s are not counted in v1.
4. **Clerk webhook (`app/api/webhooks/clerk/route.ts`)** — handle `session.created`:
   `UPDATE users SET last_login_at = now() WHERE clerk_user_id = <data.user_id>`.
   Unknown user → **200 no-op** (never 500; session events for unknown users must not
   enter Svix retry loops). This is a supplementary "sign-ins" signal only — Clerk prod
   sessions span days, so it under-counts daily activity; "active users" comes from the
   counters instead.

Worker-side keep-warm paths (`warmLanding`, `warmSeries`, crons) never pass through these
call sites, so synthetic traffic is invisible to the counters.

### 1.4 Retention

None in v1. Growth ≈ active users × ~2 rows/day — years before it matters.

---

## Part 2 — Digest pipeline

### 2.1 Module layout — `lib/notifications/abuseDigest/`

Four files, mirroring the weekly digest's separation of pure/impure:

**`loadAbuseDigestData.ts`** — all queries for a given ET day string:
- Signups that day: email, name, `created_at`; plus total user count.
- Per-user activity rollup: one row per active user — explorer queries, detail views
  (from `user_activity_daily`), watchlist adds, saved views created, custom categories
  created (COUNTs on those tables' `created_at` within the ET day window, converted via
  timestamptz range `[day 00:00 ET, next day 00:00 ET)`), and email/name from `users`.
  **Active user** = any user with ≥1 counter row or ≥1 creation that day.
- Sign-ins: users whose `last_login_at` falls within the day (supplementary line; the
  column holds only the latest stamp, so a re-sign-in before the 7:30am send can hide
  yesterday's — acceptable for a supplementary signal).
- Contact counters: `contact_submission`, `contact_honeypot` for the day.
Returns a typed `AbuseDigestStats` object. No `server-only` import (runs on the worker).

**`evaluateFlags.ts`** — pure `(stats: AbuseDigestStats) => Flag[]` where
`Flag = { severity: 'amber' | 'red'; message: string }`. Thresholds are constants in this
file (single tuning point), explicitly commented as v1 guesses:

| Signal | Amber | Red |
|---|---|---|
| Signups per day | > 10 | > 25 |
| Per-user reads (queries + detail views) | > 500 | > 2,000 |
| Per-user watchlist adds | > 50 (half the 100 cap) | — |
| Per-user saved views created | > 4 (the full 5-view quota in a day) | — |
| Per-user custom categories created | > 10 | — |
| Honeypot trips per day | > 20 | — |
| Contact submissions per day | > 10 | — |

Pure and stateless — the seam a future intra-day tripwire (deferred approach C) would
reuse unchanged.

**`buildAbuseDigestEmail.ts`** — pure
`(day: string, stats: AbuseDigestStats, flags: Flag[]) => { subject, html, text }`,
inline-styled like the existing builders.
- Subject: `KeywordQuarry daily — 2 signups · 5 active · 1,234 reads`; when flags exist,
  prefixed `⚠️ 2 flags — …`. The subject alone is the quiet-day pulse.
- Body order: flag callouts first (amber/red boxes; omitted when none), signups list,
  per-user activity table (email | queries | detail views | watchlist adds | saved views
  | categories, sorted by reads desc, capped at 25 rows + "and N more"), sign-ins line,
  contact-form line (submissions + honeypot trips), footer with generated-at timestamp
  and a link to `${APP_PUBLIC_URL}/admin`.
- Quiet day renders "All quiet" body with zeros; the email still sends.

**`sendAbuseDigest.ts`** — orchestrator
`sendAbuseDigest(opts: { day?: string; force?: boolean })`:
1. Resolve `day` (default `previousEtDay(new Date())`).
2. Idempotency: read `app_settings` key `abuse_digest:last_sent_day`; if it already
   equals/exceeds `day` and not `force`, return `skipped`.
3. Load stats → evaluate flags → build email.
4. Recipients: emails of all `users.role = 'admin'`, filtered through the existing
   `isUndeliverableEmail`. Zero recipients → warn and return without marking.
5. **One** `resend.emails.send` with the admin list in `to:`. No per-recipient tracking,
   no batching, no unsubscribe (it's an internal ops email).
6. On success, upsert the `app_settings` key to `day`. Send-then-mark: a crash between 5
   and 6 means a retry re-sends — a duplicate to the admin inbox is harmless
   (at-least-once, same philosophy as the weekly digest).
- Missing `RESEND_API_KEY` → `console.warn` + return without marking (local dev fail-soft).
- `from`: `process.env.RESEND_FROM ?? 'onboarding@resend.dev'` (matches existing senders).

### 2.2 Trigger — Inngest cron

New `inngest/functions/sendAbuseDigest.ts`: id `send-abuse-digest`, cron trigger
`TZ=America/New_York 30 7 * * *` (7:30am ET daily), `retries: 2`, single
`step.run('send', …)` wrapping the orchestrator. Registered in
`inngest/functions/index.ts`; runs on the Railway worker. The idempotency key makes retry
re-invocations safe; retries usefully cover pre-send transient errors (loader/Neon blips).

### 2.3 Admin surface

- **`app/admin/abuse-digest/page.tsx`** (admin-gated by the existing `/admin` layout):
  renders the exact email HTML inline for `?day=YYYY-MM-DD` (default yesterday ET), with
  quick links for "yesterday" and "today so far", plus a **Send now** button that posts
  the page's currently displayed day.
- **`POST /api/admin/abuse-digest/send`** (admin-gated route): body
  `{ day?: string }` → calls `sendAbuseDigest({ day, force: true })`, returns the result
  JSON. This is the post-deploy verification path — no waiting for 7:30am — and doubles
  as on-demand re-send.
- Add an "Abuse digest" link to the `/admin` sidebar nav.

### 2.4 Error handling summary

| Failure | Behavior |
|---|---|
| Counter bump fails (Neon blip) | Swallowed to `console.warn`; request unaffected; count lost |
| `session.created` for unknown user | 200 no-op (no Svix retry loop) |
| Loader/DB error in digest | Function throws → Inngest retries (2×); key unmarked |
| Resend send error | Throw → retry; key unmarked so re-send happens |
| Crash between send and mark | Duplicate email on retry — accepted (at-least-once) |
| No `RESEND_API_KEY` | Warn + skip (local dev) |
| Zero admin recipients | Warn + return unmarked |
| Digest silently broken for days | Tripwire = absence of the daily email (why always-send was chosen) |

### 2.5 Testing

- **Unit (vitest, TDD):** `etDay`/`previousEtDay` (incl. DST boundaries: 2026-03-08,
  2026-11-01), `evaluateFlags` (each threshold edge: at-threshold no-flag, above = amber,
  above red = red), `buildAbuseDigestEmail` (quiet-day variant, flagged variant, subject
  formatting, row capping at 25, honeypot line).
- **Loader:** exercised via the admin preview page against local/dev data (the repo's
  integration harness is parked WIP — do not depend on it) + typecheck.
- **E2E at ship:** deploy → visit `/admin/abuse-digest` → Send now → email arrives at
  raw5045@gmail.com; next morning confirm the 7:30am cron email.

### 2.6 Ship-time manual steps (owner)

1. Tick **`session.created`** in the Clerk dashboard → Webhooks → the
   keywordquarry.com endpoint's subscribed events.
2. Apply migration 0043 against Neon via `npx tsx scripts/applyMigration0043.ts`
   (hand-numbered convention; DDL on Neon requires explicit go-ahead).
3. Confirm no long-running worker jobs before the deploy push (Railway restart kills
   detached jobs).

## Non-goals (v1)

- No auto-enforcement (bans, throttles) — report-only.
- No configurable-threshold UI — constants in `evaluateFlags.ts`.
- No run-history table or per-send bookkeeping — one recipient set, inbox is the history.
- No intra-day alerting — deferred; `evaluateFlags` is the reusable seam.
- No middleware-level request counting — only the two read chokepoints matter.
- No counter retention/pruning — revisit if the table ever matters.
