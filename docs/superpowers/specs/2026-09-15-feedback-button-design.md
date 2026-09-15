# In-App Feedback Button — Design Spec

**Date:** 2026-09-15
**Status:** Draft for owner review (decisions below confirmed in chat)
**Scope:** A "Feedback" button in the signed-in app header that opens a small
modal with one text box. Submissions are emailed to the support inbox through
the same Resend pipeline as the contact form, with the member's account email
as reply-to and the page they were on attached. No schema changes, no worker
changes, no marketing-site changes.

## Motivation

The eCommerceFuel post will be the largest single wave of feedback the beta
gets, and it doubles as the channel eCF members use to claim lifetime access
("hit Feedback and say you're an eCF member"). The existing paths (Support →
public contact form; "reply to the welcome email") both make the member leave
the page and re-type their email. A one-box modal that carries the account
email and the current URL removes that friction and gives the owner the exact
filter state behind "this was slow / this looks wrong" without a follow-up.

## Decisions (owner-confirmed)

| Question | Decision |
|---|---|
| Storage | **Email only.** No submissions table, no admin page. eCF claims arrive as emails; the owner keeps the list until the payments arc adds a real grandfathered flag on accounts (which it needs anyway) |
| Form | **Single text box** — no category picker, no screenshot upload, no rating |
| Placement | Header button next to Support, not a nav tab, so it works from any app page without leaving it |
| Who can use it | Signed-in users only (the app layout already gates on `requireAuthenticatedUser`); no honeypot needed |
| Delivery | Sibling sender `sendFeedbackEmail` mirroring `sendContactEmail` (same env vars, same support inbox, reply-to = account email). The contact path is **not** refactored — zero regression risk in the support pipeline right before the eCF launch |
| Rate limiting | None new, consistent with the contact form (limiter work is deferred app-wide). Abuse-digest counter `feedback_submission` is bumped so volume is visible in the daily counters |
| Page context | Client sends `pathname + search` from `window.location` at submit time; server validates it as a relative path and renders it as an absolute link in the email |

## Part 1 — Validation (`lib/feedback/validate.ts`)

```ts
export interface FeedbackInput {
  message: string;      // trimmed, 10–5,000 chars (same bounds as contact)
  page: string | null;  // relative path incl. query, or null
}
export function validateFeedback(raw: unknown):
  { ok: true; input: FeedbackInput } | { ok: false; error: string };
```

Rules:
- Non-object payload → `invalid payload`.
- `message`: must be a string; trimmed length 10–5,000, else
  `message must be 10–5,000 characters`.
- `page`: optional. Accepted only if it is a string, starts with a single `/`
  (rejects `//host` protocol-relative forms and absolute URLs), contains no
  whitespace, control, or format characters, and is ≤ 2,000 chars. Anything else
  becomes `null` rather than an error — page context is a nicety, never a
  reason to lose a message.

## Part 2 — Email builder (`lib/notifications/buildFeedbackEmail.ts`)

Pure builder, mirrors `buildWelcomeEmail.ts` (no network, returns
`{ subject, text, html }`).

```ts
interface FeedbackEmailInput {
  message: string;
  page: string | null;
  user: { id: string; email: string; name: string | null };
  appUrl: string;   // process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com'
}
```

- Subject: `💬 Feedback from <name or email>`. Name is collapsed to a single
  line (same control-character guard as the contact validator) because it
  lands in a subject.
- Body (text + HTML):
  - `From: <name> <email>` (name omitted when null)
  - `Account: <user.id>` so the owner can find the row in admin
  - `Page: <appUrl><page>` as a clickable link when present, `Page: (not
    captured)` otherwise
  - The message, HTML-escaped, `white-space: pre-wrap`
  - A footer line: "Reply to this email to answer them directly." (reply-to
    is set by the sender)

## Part 3 — Sender (`lib/notifications/sendFeedbackEmail.ts`)

Copy of `sendContactEmail`'s shape: `RESEND_API_KEY` guard (warn + `{ sent:
false, reason: 'email not configured' }`), `from` =
`process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>'`,
`to` = `support@keywordquarry.com`, `replyTo` = account email, `subject/text/
html` from the builder. Returns `{ sent, reason? }` so the route can tell the
user whether the message went through. Fail-soft logging, never throws.

## Part 4 — Route (`app/api/feedback/route.ts`)

`POST /api/feedback`, `runtime = 'nodejs'`.

1. `requireAuthenticatedUser()`; `AuthError` → 401/403 via the same
   `handleAuthError` shape as `app/api/watchlist/items/route.ts`.
2. Parse JSON (malformed → `{}`), `validateFeedback` → 400 with the error.
3. `sendFeedbackEmail({ ...input, user: { id, email, name }, appUrl })` →
   503 `"Couldn't send your feedback right now — please try again later."`
   when not sent.
4. `void bumpAppActivity('feedback_submission')` (un-awaited, per the
   activity contract) → 200 `{ ok: true }`.

`lib/activity/bump.ts`: `AppActivityMetric` gains `'feedback_submission'`.
The `metric` column is `varchar(64)`, so no migration. The abuse digest
ignores unknown app metrics (it reads the two contact metrics by name), so
nothing else changes; surfacing a feedback count in the digest is a later
nicety, not part of this arc.

## Part 5 — UI (`app/(app)/_components/FeedbackButton.tsx`)

Client component rendered in `app/(app)/layout.tsx` between the Admin link
and Support, styled like Support (`text-slate-300 hover:text-white`).

Modal (rendered through `createPortal` into `document.body` so it is never
trapped in the sticky header's stacking context):
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` → title "Send
  feedback". Helper line: "What's confusing, missing, or would make
  KeywordQuarry more useful? We read every message."
- One `<textarea>` (auto-focused on open, `maxLength={5000}`, `rows={6}`),
  buttons **Send** / **Cancel**.
- States: `idle → sending → sent | error`. On `sent`, the body swaps to
  "Thanks — got it. We'll reply by email if needed." with a **Done** button.
  On `error`, the message is shown inline and the textarea keeps its text
  (never discard what the user typed).
- Closes on Cancel, Done, Escape, or backdrop click — except while sending.
  Focus returns to the header button on close.
- Submit body: `{ message, page: window.location.pathname +
  window.location.search }`. Client-side minimum length mirrors the server
  (10 chars) so the common mistake is caught before a round trip.
- Known simplification: no full focus trap (Tab can leave the dialog). Escape
  + focus return cover the realistic keyboard path; revisit if a user reports
  it.

## Testing

- `lib/feedback/validate.test.ts` — accepts trimmed message; rejects
  non-object, short, and > 5,000-char messages; page accepted for
  `/explorer?rank_max=100`; page nulled (not rejected) for `https://evil`,
  `//evil`, a path with whitespace, and > 2,000 chars.
- `lib/notifications/buildFeedbackEmail.test.ts` — subject uses name, falls
  back to email, collapses control characters; HTML-escapes the message;
  renders the absolute page link when present and the "(not captured)" line
  when null; includes the account id.
- `app/api/feedback/route.test.ts` — mocks `requireAuthenticatedUser`,
  `sendFeedbackEmail`, `bumpAppActivity` (hoisted-mock style of
  `app/api/webhooks/clerk/route.test.ts`): 401 when unauthenticated; 400 on
  a short message; 503 when the sender reports failure; 200 + sender called
  with the user's id/email/name and the validated page + counter bumped.
- `app/(app)/_components/FeedbackButton.test.tsx` (testing-library, jsdom):
  modal hidden until click; submit posts `{ message, page }` with the
  current location; success state shown; error keeps the typed text; Escape
  closes.
- `pnpm typecheck` and the full `pnpm test` run green before commit.

## Non-goals

- Storing submissions, an admin list, or tagging eCF accounts in the app
  (payments arc).
- Category pickers, screenshots, ratings, or a public (signed-out) feedback
  form — the contact form already covers signed-out users.
- Rate limiting beyond the existing deferral; surfacing feedback counts in
  the abuse digest.

## Ship checklist (owner-gated)

1. Local verification: typecheck + tests, then the modal exercised in the
   browser on the dev server (open, send, error path with the API key
   unset, Escape).
2. Push authorization (run `scripts/checkActiveJobs.ts` first — the Railway
   worker restarts on push).
3. Owner sends one real feedback message on prod and confirms it lands in
   the support inbox with the account email as reply-to and a working page
   link.
4. Finalize the eCF post's claim sentence against the shipped button label.
