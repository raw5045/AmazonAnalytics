# Weekly Digest Email — Design Spec

Date: 2026-05-31
Owner: Reese
Status: Ready for implementation planning
Predecessors: Plan 3.4.2 (Watchlist), Plan 3.4.3 (Watchlist Bulk Add)

## 1. Summary

When a new week's keyword refresh completes, an admin can broadcast a weekly digest email to all subscribed users. The email comes in two variants:

- **Broadcast** (user has 0 watched keywords): a lightweight "new week is live — come explore" message with a CTA to `/explorer`.
- **Watchlist** (user has ≥ 1 watched keyword): the same intro plus a table of every watched keyword's current-week movement (current rank, prior-week rank, 4-week-ago rank, 1-week Δ, est. monthly volume), sorted gains-first (see amended Row order below).

Sending is **admin-triggered** from a new `/admin/digests` page, not auto-fired on import. The digest can only be sent for the **current snapshot week** (the week `keyword_current_summary` currently reflects); prior weeks are frozen read-only history. Every email carries a one-click unsubscribe link.

This is the long-deferred notifications work flagged in the Plan 3.4.2 and 3.4.3 specs. It is the first **user-facing** email in a codebase whose existing emails (import / enrichment / calibration outcomes) are all admin-only.

## 2. Decisions locked

| Area | Decision |
|---|---|
| Email provider | Resend (already installed + used by `lib/notifications/send*Email.ts`) |
| Builder pattern | Pure `buildX` function + Resend wrapper + fail-soft, mirroring `buildImportEmail.ts` / `sendImportEmail.ts` |
| Variant split | `watchlist_count > 0` → watchlist variant; `= 0` → broadcast variant |
| Watchlist content | Full snapshot — every watched keyword every week (not just movers) |
| Email columns | 6: keyword, current rank, prior-week rank, 4-week-ago rank, Δ (1w), est. monthly volume |
| Row order | **Amended 2026-07-20 (owner request):** signed movement — biggest gains first through biggest declines last (`ORDER BY improvement_1w DESC`), nulls last, ties broken by current rank asc. Originally shipped as `ORDER BY \|improvement_1w\| DESC` (absolute movers first). |
| Fell-out-of-rankings | Still shown, with `current_rank` "—" and a muted "not ranked this week" note |
| Recipients | All subscribed users with a non-null email |
| No-watchlist users | Yes — they receive the broadcast variant (re-engagement nudge) |
| Trigger | Admin button on `/admin/digests`, current week only |
| Idempotency | `weekly_digest_runs` PK on `week_end_date` — a week can only be sent once |
| Retry | "Retry failures" available **only on the current week**; prior weeks are frozen |
| Send fan-out | Resend batch API in chunks of 100; per-`(week, user)` status rows |
| Opt-out | `users.weekly_digest_subscribed BOOLEAN NOT NULL DEFAULT true` + signed-token footer link |
| Subscribe-on-signup | Automatic via the column default — no auth-path code change |
| Unsubscribe UX | One-click GET unsubscribe + confirmation page with inline re-subscribe |
| Link security | HMAC-signed token (`DIGEST_UNSUB_SECRET`); no expiry |
| Deliverability | Also set `List-Unsubscribe` + `List-Unsubscribe-Post` headers (RFC 8058) |
| Preview | Non-sending browser preview at `/admin/digests/preview?variant=…` |
| Settings page | Out of scope (YAGNI — one notification type) |

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ /admin/digests page (admin-gated)                                    │
│ ├── Recent weeks list (reporting_weeks ⟕ weekly_digest_runs)         │
│ ├── [Send digest] / [Retry failures] — current week only            │
│ └── [Preview ▸] links → /admin/digests/preview?variant=…            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ POST /api/admin/digests/send
                           ▼
              ┌──────────────────────────────────┐
              │ Inngest: digest.send-weekly        │
              │ 1. INSERT weekly_digest_runs       │ ← idempotency gate
              │    ON CONFLICT DO NOTHING          │
              │    (retry mode: skip this insert)  │
              │ 2. Load eligible recipients (Q1)   │
              │ 3. Load watchlist rows (Q2)         │
              │ 4. Partition into variants          │
              │ 5. For each chunk of 100:           │
              │    - build personalized html/text   │
              │    - Resend batch send              │
              │    - write weekly_digest_sends rows │
              │ 6. Roll up status onto digest_runs  │
              └──────────────────────────────────┘

Every email footer:
  Unsubscribe → /api/notifications/unsubscribe?token=<HMAC>
  (+ List-Unsubscribe headers carrying the same URL)
```

The pure builder / Resend wrapper / fail-soft pattern is identical to the existing import-email code. The Inngest function is new because per-user-personalized fan-out with retry is new (the existing emails send one identical message to all admins).

**Trigger mechanism note:** the admin button POSTs to an API route that fires an Inngest event (`digest.send-weekly`), matching the existing `KeepaEnrichmentButton` → `/api/admin/keepa-enrichment/fire-full` → Inngest pattern. For the current small recipient base, an Inngest function (with step retries) is the right fit. If the recipient list ever grows large enough to risk Inngest's HTTP invocation timeout, the escape hatch is the worker in-process job runner (the path `importBatch` already uses) — out of scope for v1.

## 4. Schema (migration 0033)

Three objects, all additive. No changes to existing tables beyond one new column.

```sql
-- Per-user opt-out. Defaults to subscribed so the broadcast reaches
-- everyone on day one; new accounts inherit `true` automatically (the
-- syncUserFromClerk INSERT needs no change). Users self-serve out via
-- the email footer link.
ALTER TABLE users
  ADD COLUMN weekly_digest_subscribed BOOLEAN NOT NULL DEFAULT true;

-- One row per week sent. PK on week_end_date is the idempotency gate:
-- a week can never be sent twice. Holds the week-level aggregate status
-- the admin page renders.
CREATE TABLE weekly_digest_runs (
  week_end_date    date        PRIMARY KEY,
  status           text        NOT NULL,
    -- 'sending' | 'sent' | 'sent_with_failures' | 'failed'
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  recipients_count int         NOT NULL DEFAULT 0,
  sent_count       int         NOT NULL DEFAULT 0,
  failed_count     int         NOT NULL DEFAULT 0,
  triggered_by     uuid        REFERENCES users(id) ON DELETE SET NULL
);

-- One row per (week, user). The grain at which sends are idempotent and
-- retryable: a resume re-sends the not-yet-sent rows (status IN
-- ('failed','pending')); 'sent' rows are never re-touched.
CREATE TABLE weekly_digest_sends (
  week_end_date  date        NOT NULL
                   REFERENCES weekly_digest_runs(week_end_date) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant        text        NOT NULL, -- 'watchlist' | 'broadcast'
  status         text        NOT NULL, -- 'pending' | 'sent' | 'failed'
  resend_id      text,                 -- Resend email id, for postmortem
  error          text,                 -- truncated to 1000 chars
  sent_at        timestamptz,
  PRIMARY KEY (week_end_date, user_id)
);

-- Cheap "find failures to retry" lookup.
CREATE INDEX weekly_digest_sends_failed_idx
  ON weekly_digest_sends (week_end_date)
  WHERE status = 'failed';
```

Drizzle schema lives in a new `db/schema/weeklyDigest.ts` (both tables) plus the new column added to `db/schema/users.ts`; both are exported from `db/schema/index.ts`.

**Why `weekly_digest_runs.status` is denormalized from the send rows:** keeping it on the run row lets the admin status badge render from one query rather than a `GROUP BY` over `weekly_digest_sends` per page load.

**Why store `variant` on the send row:** audit/debuggability — we can see which variant a user received without recomputing from their (possibly since-changed) watchlist count.

## 5. The "current week only" constraint

`keyword_current_summary` is a **singleton snapshot** — it only ever holds the most recently refreshed week's data (see `refreshSummary.ts`, which rebuilds it and swaps it atomically). The digest's rank / Δ / volume numbers come from that table.

Therefore a digest can only be sent for the **current snapshot week** — the `current_week_end_date` recorded in `keyword_current_summary_meta`. Sending "for" any other week would attach the wrong week's numbers.

This matches the intended workflow: import a week → refresh makes it current → admin reviews → admin sends *that* week's digest. The admin page is built around this: the current week is the only sendable row; all prior weeks are frozen read-only history.

**Consequence for retries:** "Retry failures" is also only ever available on the current week. Once the next week's refresh runs and the snapshot rolls over, the prior week freezes — any unsent failures for it are simply superseded by the new week's digest. There is no mechanism (and no need) to send or retry a historical week.

## 6. Data flow — assembling each email

The Inngest function runs **two queries total** (not one per user), then assembles in memory.

### Query 1 — eligible recipients + variant

```sql
SELECT u.id, u.email, COUNT(w.keyword_id)::int AS watchlist_count
FROM users u
LEFT JOIN watchlist_items w ON w.user_id = u.id
WHERE u.email IS NOT NULL
  AND u.weekly_digest_subscribed = true
GROUP BY u.id, u.email;
```

Each row → `{ userId, email, watchlistCount }`. `watchlistCount > 0` selects the watchlist variant, `= 0` the broadcast variant.

**Retry mode:** when retrying/resuming a recoverable week, this set is further restricted to users with a **not-yet-sent** `weekly_digest_sends` row — `status IN ('failed','pending')` — for that week. This covers both previously-failed users and users who were seeded but never attempted (e.g. a mid-send crash left them `pending`). Delivered (`sent`) users are excluded, so they're never re-emailed.

### Query 2 — watched keywords' current-week metrics

```sql
SELECT w.user_id,
       st.id  AS search_term_id,
       st.search_term_raw,
       kcs.current_rank,
       kcs.prior_week_rank,
       kcs.rank_4w_ago,
       kcs.improvement_1w,
       kcs.estimated_monthly_volume_current
FROM watchlist_items w
JOIN search_terms st ON st.id = w.keyword_id
LEFT JOIN keyword_current_summary kcs ON kcs.search_term_id = w.keyword_id
WHERE w.user_id = ANY($1);   -- only watchlist-variant user ids
```

The `LEFT JOIN` is deliberate: a keyword that fell out of this week's rankings still returns, with `current_rank = NULL` → renders as the "not ranked this week" row.

### In-memory assembly

Group Query-2 rows by `user_id`; sort each user's list by `ABS(improvement_1w)` descending (nulls last), ties broken by `current_rank` ascending. Hand each group to the email builder.

### Why a purpose-built query, not `fetchExplorerRowsByIds`

The watchlist page's loader (`fetchExplorerRowsByIds`) returns only one "prior rank" column, chosen by the selected window. The email needs **both** prior-week rank and 4-week-ago rank simultaneously. A dedicated query is cleaner than calling that helper twice and merging.

### Module

`lib/notifications/digest/loadDigestData.ts` exports:

```ts
interface DigestRecipient {
  userId: string;
  email: string;
  watchlistCount: number;
}

interface DigestKeywordRow {
  searchTermId: string;
  searchTermRaw: string;
  currentRank: number | null;
  priorWeekRank: number | null;
  rank4wAgo: number | null;
  improvement1w: number | null;
  estMonthlyVolume: number | null;
}

// All subscribed recipients (optionally restricted to a retry set —
// the not-yet-sent users for a week: status IN ('failed','pending')).
export async function loadEligibleRecipients(
  opts?: { onlyUnsentForWeek?: string },
): Promise<DigestRecipient[]>;

// Watched keyword rows for the given users, grouped + sorted
// biggest-mover-first per user.
export async function loadWatchlistRowsByUser(
  userIds: string[],
): Promise<Map<string, DigestKeywordRow[]>>;
```

Both are pure data-loaders (no email/network), independently testable.

## 7. Email content

### Broadcast variant (watchlist_count = 0)

```
Subject: Amazon Keywords Updated! Explore new week of keyword changes

  Amazon Keywords Updated

  The week of <week_end_date> is now live. Fresh ranks, deltas, and
  volume estimates are ready to explore.

  [ Explore the keyword data → ]          → links to <appUrl>/explorer

  ───────────────────────────────────────
  You're receiving this weekly digest because you have an account.
  Unsubscribe
```

### Watchlist variant (watchlist_count > 0)

```
Subject: Amazon Keywords Updated! See what changed in your Watchlist and explore today!

  Amazon Keywords Updated

  The week of <week_end_date> is live. Here's how your <N> watched
  keywords moved this week — biggest movers first:

  ┌────────────────────┬───────┬───────┬───────┬───────┬──────────┐
  │ Keyword            │ Rank  │ Prior │ 4w    │ Δ 1w  │ Est. vol │
  ├────────────────────┼───────┼───────┼───────┼───────┼──────────┤
  │ wireless earbuds   │ 1,204 │ 1,520 │ 2,100 │ +316  │   45K    │  ← green Δ
  │ airpods case       │ 8,910 │ 7,200 │ 6,800 │ −1,710│   12K    │  ← red Δ
  │ vanished keyword   │  —    │ 4,000 │ 3,900 │  —    │   —      │  ← muted "not ranked this week"
  │ … all watched keywords, |Δ| desc …                            │
  └────────────────────┴───────┴───────┴───────┴───────┴──────────┘

  [ Open your watchlist → ]               → links to <appUrl>/watchlist

  ───────────────────────────────────────
  You're receiving this because you watch keywords on Amazon Analytics.
  Unsubscribe
```

### Rendering rules

- **Δ cell color** (same semantics as the explorer's `DeltaCell`): improvement (rank dropped, `improvement_1w > 0`) = green `+N`; decline (`< 0`) = red `−N`; `0` = gray `0`; no prior-week data (`improvement_1w` null) = gray "—".
- **Keyword name** links to `<appUrl>/explorer/keyword/<searchTermId>`.
- **Ranks** use `toLocaleString()` (thousands separators). **Volume** uses the explorer's compact format (`45K`, `1.2M`, `1,234`), reusing the same formatting logic the explorer table uses (extracted/shared, not duplicated).
- **Not-ranked row** (`current_rank` null): current rank and Δ render as muted "—"; the row carries a small "not ranked this week" annotation so the user understands why.
- **HTML**: a single inline-styled `<table>` (email clients ignore external/`<style>` CSS), following the existing `htmlShell` approach in `buildImportEmail.ts`. **Plain-text fallback**: each keyword as `keyword — rank N (prior P, 4w F, Δ D), est vol V`, one per line.
- **Footer** (both variants): the standard "why you're getting this" line + an `Unsubscribe` link to `/api/notifications/unsubscribe?token=<token>`.

### Module

`lib/notifications/digest/buildDigestEmail.ts` — pure functions, no network:

```ts
interface DigestEmailCommon {
  weekEndDate: string;
  appUrl: string;
  unsubscribeUrl: string;   // already token-signed by the caller
}

interface BroadcastInput extends DigestEmailCommon { variant: 'broadcast'; }

interface WatchlistInput extends DigestEmailCommon {
  variant: 'watchlist';
  rows: DigestKeywordRow[];   // already sorted biggest-mover-first
}

interface BuiltEmail { subject: string; text: string; html: string; }

export function buildDigestEmail(input: BroadcastInput | WatchlistInput): BuiltEmail;
```

## 8. Send engine

`lib/notifications/digest/sendWeeklyDigest.ts` orchestrates the actual send; the Inngest function (`inngest/functions/sendWeeklyDigest.ts`, registered in `inngest/functions/index.ts`) wraps it with the idempotency gate and step structure.

### Flow

1. **Idempotency gate** — `INSERT INTO weekly_digest_runs (week_end_date, status, triggered_by) VALUES ($week, 'sending', $admin) ON CONFLICT (week_end_date) DO NOTHING`. If no row was inserted (week already exists) **and** this is not an explicit retry → exit without sending. Retry mode is signalled by the triggering event payload and is allowed only when the existing row is in a **recoverable** state: either `sent_with_failures`, or a stale `sending` (started > 15 min ago with `finished_at` null — a run that crashed past Inngest's own retries). In retry mode, the gate updates the existing row back to `sending` rather than inserting.
2. **Load recipients** (Query 1; retry mode restricts to **not-yet-sent** rows — `status IN ('failed','pending')` — so a resumed run picks up both previously-failed users and users who were never attempted before a mid-send crash). Seed `weekly_digest_sends` rows with `status = 'pending'` for any recipient that doesn't already have a row for this week (`ON CONFLICT DO NOTHING`).
3. **Load watchlist rows** (Query 2) for watchlist-variant users; build the per-user map.
4. **Chunk** recipients into groups of 100 (Resend batch max).
5. **Per chunk**: build each recipient's personalized `{subject, html, text}` (with their own signed unsubscribe URL + `List-Unsubscribe` headers), call Resend's **batch** endpoint, then write each user's `weekly_digest_sends` row to `sent` (with `resend_id`) or `failed` (with truncated `error`). A `(week, user)` already at `sent` is never re-sent.
6. **Roll up** — update `weekly_digest_runs` with `recipients_count`, `sent_count`, `failed_count`, `finished_at`, and final `status` (`sent` if zero failures, else `sent_with_failures`; `failed` if the run threw before any send).

### Idempotency invariant

**Every send is idempotent at the `(week_end_date, user_id)` grain.** No reachable path ever re-sends to a `(week, user)` already marked `sent`:

- **First send** (`retry=false`): the run-level gate INSERTs the run row; if it already exists the call exits `already_sent`, so the send loop only ever runs once per week for a fresh send — no rows are `sent` yet, so re-blasting is impossible.
- **Resume/retry** (`retry=true`): the recipient set is filtered to not-yet-sent users (`status IN ('failed','pending')`), so `sent` users are never even loaded.

**Recovery model (important):** because the gate exits `already_sent` on a duplicate `retry=false` invocation, Inngest's *automatic* retries do **not** resume a crashed mid-send run — they simply no-op against the existing run row (which is safe, just not a resume). Recovery from a genuine mid-send crash is **manual**: once the run row has sat stale in `sending` for > 15 min (no `finished_at`), the admin page surfaces a **Resume send** action (retry=true) that re-runs against the not-yet-sent set. Automatic retries still usefully cover *pre-gate* transient errors (e.g. the initial INSERT failing on a Neon blip), since those leave no run row and a retry can cleanly re-enter.

### Failure handling

| Failure | Behavior |
|---|---|
| Double-click / re-send same week | Idempotency gate exits; UI also disables Send once status ≠ "Not sent" |
| Resend fails for some recipients in a chunk | Those users → `failed`; run → `sent_with_failures`; delivered users untouched |
| Admin retries failures | Re-run restricted to not-yet-sent rows (`status IN ('failed','pending')`) for the current week; delivered (`sent`) users never re-touched |
| Whole run crashes mid-send | Automatic Inngest retries do **not** resume (they no-op against the existing run row — safe, not a resume). Recovery is manual: once the run is stale in `sending` (> 15 min, no `finished_at`) the admin page shows a **Resume send** action, which re-runs against the not-yet-sent set (so both `failed` and never-attempted `pending` users get picked up) |
| `RESEND_API_KEY` missing (local dev) | Fail-soft: log a warning, leave send rows `pending` (the schema has no `skipped` status), mark the run `sent`, don't crash — same fail-soft spirit as existing emails |

### Chunk size

100 (Resend batch maximum). For the current user base this is a single chunk; chunking only engages beyond 100 recipients.

## 9. Admin page — `/admin/digests`

Server component, admin-gated by the existing `app/admin/layout.tsx`. A nav link is added to the admin surface.

```
Weekly Digests

Current week: 2026-05-23     (from keyword_current_summary_meta)

┌──────────────┬────────────┬──────────────────────┬──────────────────┐
│ Week         │ Refresh    │ Digest status        │ Action           │
├──────────────┼────────────┼──────────────────────┼──────────────────┤
│ 2026-05-23   │ ✓ current  │ Not sent             │ [ Send digest ]  │  enabled
│ 2026-05-16   │ ✓ complete │ Sent · 42 recipients │ —                │
│ 2026-05-09   │ ✓ complete │ Sent · 40 (2 failed) │ —                │  frozen
│ 2026-05-02   │ ✓ complete │ Not sent             │ data not current │  disabled
└──────────────┴────────────┴──────────────────────┴──────────────────┘

Preview:  [ Watchlist variant ▸ ]   [ Broadcast variant ▸ ]
```

- Weeks list: `reporting_weeks WHERE is_complete = true ORDER BY week_end_date DESC LIMIT 12`, left-joined to `weekly_digest_runs`.
- **Send digest**: enabled only on the row whose `week_end_date` equals the current snapshot week (`keyword_current_summary_meta.current_week_end_date`) **and** whose digest status is "Not sent."
- **Retry failures**: replaces Send on the current-week row when its status is `sent_with_failures`. A current-week row stuck in a stale `sending` state (> 15 min, no `finished_at`) instead shows **Resume send** (same code path, retry mode). Neither ever appears on prior weeks.
- Prior weeks: status text only, no buttons ("data not current").
- **Confirmation dialog** on Send (matching `KeepaEnrichmentButton`): *"Send the weekly digest for `<week>` to all subscribed users? This emails N recipients and can't be unsent."* (N from a count of eligible recipients.)
- After firing, the row shows "Sending…"; the page mirrors the existing `AutoRefresh.tsx` pattern (or a manual refresh) to show the final counts.

### Components / routes

- `app/admin/digests/page.tsx` — the table (server component).
- `app/admin/digests/SendDigestButton.tsx` — client button (`idle/firing/sent/failed` pattern from `KeepaEnrichmentButton.tsx`), handles both Send and Retry modes.
- `app/api/admin/digests/send/route.ts` — admin-gated; validates the requested week == current snapshot week; fires the `digest.send-weekly` Inngest event (with optional `retry: true`); returns the event id.

## 10. Preview (non-sending)

`app/admin/digests/preview/page.tsx` — admin-gated server component. Reads `?variant=watchlist|broadcast` and renders the **actual email HTML** in the browser (no send).

- **Watchlist preview**: uses the admin's own watched keywords for the current week (via the same `loadWatchlistRowsByUser` loader). If the admin has no watchlist, falls back to a small hard-coded sample row set so the layout is still visible.
- **Broadcast preview**: renders the broadcast variant directly.
- The unsubscribe link in the preview points at a real signed token for the admin (harmless — clicking it would just unsubscribe the admin, who can re-subscribe).

This is the primary "test the email design" affordance and the answer to "how do I see it without emailing everyone."

## 11. Unsubscribe / re-subscribe

`app/api/notifications/unsubscribe/route.ts`:

- **Token**: HMAC-SHA256 signature over a payload `{ userId, purpose: "unsubscribe-digest" }`, using `DIGEST_UNSUB_SECRET`. Encoded as `base64url(payload).base64url(signature)`. **No expiry** — an unsubscribe link from an old email must always work. Verification recomputes the HMAC and constant-time-compares; tamper / wrong purpose → 400.
- **GET** (`?token=…`): verify → `UPDATE users SET weekly_digest_subscribed = false WHERE id = $userId` → return a small inline-styled HTML confirmation page: *"You've been unsubscribed from the weekly digest. Changed your mind? [Re-subscribe]"*. The Re-subscribe button is a form that **POSTs** the same token back to this route.
- **POST** (token in body): verify → `UPDATE … SET weekly_digest_subscribed = true` → return the same page reading *"You're re-subscribed."*
- **One-click** semantics (chosen over two-step): the GET performs the unsubscribe immediately. Risk: email security scanners that follow links could auto-unsubscribe someone; mitigated because the confirmation page offers one-click re-subscribe and the worst case is one missed weekly email. Idempotent: repeat GETs just re-set `false`.

Token helpers live in `lib/notifications/digest/unsubToken.ts` (`signUnsubToken(userId)`, `verifyUnsubToken(token)`), pure and unit-tested.

**List-Unsubscribe headers**: the send engine sets `List-Unsubscribe: <appUrl/api/notifications/unsubscribe?token=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on every message, reusing the same token. This gives Gmail/Apple Mail their native unsubscribe affordance and improves inbox placement.

## 12. Testing approach

**Unit tests** (pure, no network — highest value):

- `buildDigestEmail.test.ts`:
  - Broadcast variant: correct subject; explore CTA points at `/explorer`; unsubscribe link present.
  - Watchlist variant: 6-column table; rows in `|Δ|`-desc order (verify a known unsorted input comes out sorted); Δ color classes (green improvement / red decline / gray zero / gray "—" no-prior); "not ranked this week" row when `currentRank` null; per-keyword detail link; plain-text fallback lists every keyword; unsubscribe link present.
- `unsubToken.test.ts`: sign→verify round-trip returns the userId; tampered token rejected; wrong-`purpose` payload rejected; garbage input rejected (no throw, returns null/invalid).
- Recipient categorization + chunking helpers: `watchlistCount > 0 → 'watchlist'`; chunking 0/1/100/101/250 recipients into the expected group sizes.
- `loadDigestData` (mocked `db`, mirroring `bulkAdd.test.ts`): Query-1 maps rows to `DigestRecipient`; Query-2 grouping by user + biggest-mover-first sort (including nulls-last and the tie-break).

**Manual smoke** (the browser preview makes this safe):
- Open `/admin/digests/preview?variant=watchlist` with watched keywords → table renders, colors + sorting correct, not-ranked row shows.
- Open `?variant=broadcast` → CTA renders.
- Send for the current week to a tiny test set (e.g., your own admin + one test account, one with a watchlist and one without) → both inboxes render; `weekly_digest_runs` / `weekly_digest_sends` rows reflect the outcome; tab badge of recipient count matches.
- Click the unsubscribe link → confirmation page; `weekly_digest_subscribed` flips false; re-subscribe restores it.
- Re-click Send for the same week → idempotency gate blocks a second send.

## 13. Out of scope (deferred or never)

| Item | Reason |
|---|---|
| Per-type `notification_preferences` table + account settings page | YAGNI — one notification type today; the single column covers it |
| Auto-fire digest on import completion | Admin-triggered chosen for the data-sanity gate |
| Cron-scheduled send | Decoupled-from-import timing not wanted; admin controls timing |
| Keepa columns (price / reviews / leaf category) in the email | Not ready at send time (~a day lag) + email width |
| Cancel-in-flight send | Premature; small recipient base |
| Recipient-list visibility dialog | Questionable value for v1 |
| Sending / retrying digests for historical (non-current) weeks | `keyword_current_summary` only holds the current week |
| Two-step unsubscribe confirm | One-click chosen; re-subscribe covers accidental scanner clicks |

## 14. File inventory

**New files:**
- `db/migrations/0033_weekly_digest.sql`
- `db/schema/weeklyDigest.ts`
- `lib/notifications/digest/unsubToken.ts` + `unsubToken.test.ts`
- `lib/notifications/digest/buildDigestEmail.ts` + `buildDigestEmail.test.ts`
- `lib/notifications/digest/loadDigestData.ts` (+ tests)
- `lib/notifications/digest/recipients.ts` — categorize + chunk pure helpers (+ tests) *(may be co-located in loadDigestData/sendWeeklyDigest if small)*
- `lib/notifications/digest/sendWeeklyDigest.ts`
- `inngest/functions/sendWeeklyDigest.ts`
- `app/admin/digests/page.tsx`
- `app/admin/digests/SendDigestButton.tsx`
- `app/admin/digests/preview/page.tsx`
- `app/api/admin/digests/send/route.ts`
- `app/api/notifications/unsubscribe/route.ts`

**Modified files:**
- `db/schema/users.ts` — add `weeklyDigestSubscribed`
- `db/schema/index.ts` — export the new tables
- `inngest/functions/index.ts` — register `sendWeeklyDigestFn`
- Admin nav (wherever the admin section links live) — add a "Digests" link

## 15. Proposed phasing

Each phase is independently shippable/testable.

1. **Schema + subscribe-on-signup** — migration 0033, drizzle schema, users column, exports. (Subscribe-on-signup is free via the column default.)
2. **Pure core (TDD)** — `unsubToken`, `buildDigestEmail` (both variants), categorize + chunk helpers, with full unit tests.
3. **Data loaders** — `loadEligibleRecipients`, `loadWatchlistRowsByUser`.
4. **Send engine + Inngest function** — orchestration, idempotency gate, chunked Resend batch, per-user status rows, retry-failures path, List-Unsubscribe headers.
5. **Admin page + send route + preview route** — `/admin/digests`, Send/Retry button, `/api/admin/digests/send`, `/admin/digests/preview`.
6. **Unsubscribe / re-subscribe flow** — `/api/notifications/unsubscribe` GET + POST + confirmation page.
7. **E2E + ship** — manual smoke via preview + tiny test send, typecheck/lint, deploy, verify.

## 16. Acceptance criteria

- [ ] Admin sees `/admin/digests` with recent weeks and accurate digest statuses.
- [ ] Send is enabled only on the current snapshot week and only when "Not sent."
- [ ] Clicking Send fires the digest; the run + per-user send rows are written; the week shows "Sent · N recipients."
- [ ] Watchlist users receive the 6-column table sorted biggest-mover-first; Δ colors correct; fell-out keywords show "not ranked this week."
- [ ] No-watchlist users receive the broadcast variant with the explore CTA.
- [ ] A second Send for the same week is a no-op (idempotency gate).
- [ ] A `sent_with_failures` current week offers "Retry failures," re-sending only the failed users; a stale `sending` current week offers "Resume send."
- [ ] Every email has a working one-click unsubscribe that flips `weekly_digest_subscribed` to false; the confirmation page re-subscribes.
- [ ] `List-Unsubscribe` headers present on sent messages.
- [ ] Browser preview renders both variants without sending.
- [ ] New accounts are subscribed by default.
- [ ] Missing `RESEND_API_KEY` does not crash the send (fail-soft).
- [ ] Prior weeks are frozen: no Send/Retry buttons regardless of status.
