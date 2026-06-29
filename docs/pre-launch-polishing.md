# Pre-Launch Polishing List

**Date:** 2026-06-29 · **Bar:** first few *early-external* users (P0 blockers thorough; polish flagged but lower) · **Method:** four parallel code-driven review passes — onboarding/first-run, core flows + empty/loading/error states, security/multi-user, reliability/ops.

**Not covered here:** visual consistency, mobile/responsive layout, and real interaction testing — those need the **dogfooding pass** (drive the live site in a browser). Performance/cold-start was handled separately (see [app-cold-start-investigation.md](app-cold-start-investigation.md)).

## TL;DR

- **Biggest reassurance:** security + multi-user isolation is solid — **no P0s** there. No cross-user leakage, no missing auth, no injection; data is correctly `userId`-scoped throughout.
- **Biggest gap:** there is **no error boundary or `not-found` page** anywhere outside `/admin` — flagged independently by 3 of the 4 passes. Any thrown error or bad URL shows Next's raw screen.
- Counts: **5 P0**, **15 P1**, **11 P2**. Most P0s are cheap, boilerplate-y structural files.

---

## P0 — Fix before any real user

**1. No error boundaries (users see raw crash screens)** — missing `app/error.tsx`, `app/global-error.tsx` (flagged by 3 passes). Any throw in a Server Component load (`runExplorerQuery`, `fetchKeywordChartData`, watchlist/CB loaders, a Neon blip) falls through to Next's unstyled "Application error" / blank page.
→ Add `app/(app)/error.tsx` (`'use client'`, with a reset button) covering the four user pages, plus `app/global-error.tsx` for root-layout throws.

**2. No root `not-found.tsx`** — only `app/admin/not-found.tsx` exists. A bad URL outside `/admin` (typo, or a stale `/explorer/keyword/<deleted-id>` link from a digest email) hits Next's default 404, not your chrome.
→ Add `app/not-found.tsx`.

**3. Keyword-detail streamed history can tear down the whole page** — `app/(app)/explorer/keyword/[id]/page.tsx:~203` + `WeeklyHistoryTable.tsx`. The slow `fetchKeywordRawHistory` runs inside `<Suspense>` with no error boundary; if it throws (timeout/DB), the error propagates and breaks the page *after* it already painted (defeating the fast-first-paint design).
→ Wrap that `<Suspense>` in a local error boundary so a failed history load shows "couldn't load history" inline while the charts stay. (Same fix family as #1.)

**4. Keepa fetch has no timeout — silent multi-hour hang (ops)** — `lib/keepa/client.ts:~42` (`fetch` with no `AbortSignal`). A stalled Keepa connection blocks the per-ASIN enrichment loop indefinitely; the heartbeat is a *separate* `setInterval`, so the job keeps writing fresh beats, never trips orphan detection, and hangs ~19–24h with no failure email.
→ `AbortSignal.timeout(30_000)` on the fetch; ideally track "last successful call" so a wedged fetch becomes detectable.

**5. Stock Next.js favicon** — `app/favicon.ico` is the 25 KB scaffold default. First external users see the generic Next icon in the tab/bookmarks — reads as unfinished.
→ Drop in a real `app/icon.png` / `favicon.ico`. (Trivial; grouped as P0 only because it's the literal first impression and a 5-minute fix.)

---

## P1 — Should fix before launch

### External-facing polish
- **Marketing landing is a bare `<h1>` + two text links** — `app/(marketing)/page.tsx:10-22`. No value prop for a cold visitor. → Add a headline + 1–2 sentence subhead + a styled primary CTA. *(Higher priority if users arrive via the public page rather than a direct invite link.)*
- **"SFR" jargon never expanded** — `app/layout.tsx`, landing, `app/app/page.tsx`. → Gloss it once: "Search Frequency Rank — how often shoppers search a term."
- **Generic browser-tab titles on sign-in / sign-up** — `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx` inherit the root title. → Export `metadata.title` from each.
- **`/app` landing orients only to Explorer** — `app/app/page.tsx:7-24` ignores Watchlist + Category Builder. → Add a brief "getting started" pointing at all three.

### Robustness & user feedback
- **Watchlist has no `loading.tsx`** — `app/(app)/watchlist/` (the only main page missing one); two sequential awaits with no instant skeleton. → Add a header + table skeleton.
- **Explorer ⭐ star is mute on error/cap** — `ResultsTable.tsx:~143` doesn't pass `onError` to `WatchStar`; hitting the 100-keyword cap from the list silently reverts with no message (the detail-page toggle handles this). → Surface a toast/inline message, esp. `watchlist_at_cap`.
- **Category-builder drill/add show misleading empty states on failure** — `CategoryBuilderClient.tsx:101-106` & `117-119`. A failed `tree` fetch renders "No sub-categories."; a failed `leaves` fetch shows "Nothing to add." → Set an error state, render a "Couldn't load — retry" row.
- **"Page past the end" blames the filters** — `app/(app)/explorer/page.tsx:172` + `parseFilters.ts:152`. `?page=99999` returns 0 rows and shows "try removing a filter." → Detect `rows===0 && page>1`, show "go to page 1" (or clamp page).

### Reliability & ops
- **Clerk webhook has no try/catch around the DB sync** — `app/api/webhooks/clerk/route.ts:59-67`. A Neon blip on `user.created` → unhandled 500, account half-provisioned (signs in via Clerk, no app row, no digests). → Wrap in try/catch, return 500 so Clerk retries, log the clerkUserId.
- **Monthly-SFR ingest timeout sends no notification** — `inngest/functions/processMonthlySfr.ts:54-60` (calibration's sibling *does* email). → Mirror the timeout email.
- **No rate-limiting on any endpoint** — all `app/api/**`. Bulk add (up to `HARD_MAX_INPUT` keywords), creates, and the heavy explorer broad-search (shared 3-connection pool) are unthrottled; one client can exhaust the pool or hammer writes. → Add a per-user/IP limiter on bulk + creates + the broad path.
- **Public taxonomy routes = uncached DB compute per hit** — `app/api/category-builder/{tree,leaves}/route.ts`. Reachable signed-out with arbitrary `?path=`; novel paths bypass `unstable_cache` and hit Neon — a cheap DB-amplification vector. → Edge rate-limit and/or short `Cache-Control`.
- **Unsubscribe link is a non-expiring bearer token** — `app/api/notifications/unsubscribe/route.ts` (`signUnsubToken` carries only `userId`). Anyone who sees one old email can toggle that user's subscription forever. → Add an expiry/issued-at claim.
- **Dead `summary/refresh-requested` event** — fired at `inngest/functions/importBatch.ts:287`, no registered consumer (refresh runs inline in `importFile.ts`). A future handler would double-run the 30-min refresh concurrently (two writers racing). → Delete the `step.sendEvent` or comment that refresh is inline + intentionally unconsumed.

---

## P2 — Nice-to-have / hardening

- **Silent network-error UX:** saved-view rename/save (`SaveViewButton.tsx:60`, `SavedViewsDropdown.tsx:96` — `try/finally` no `catch`); sub-3-char search silently dropped with no hint (`FilterSidebar.tsx:103`). → Add inline error/hint text.
- **Limit enforcement is non-atomic** — watchlist/saved-views/custom-categories do `COUNT(*)` then insert; two concurrent requests can overshoot the cap by one. → Partial unique index or `FOR UPDATE` if strictness matters.
- **No size bound on stored `filters` / `leafNames` JSON** — `saved-views` & `custom` validators check name length only. → Add a max array-size/length guard.
- **`import-status` leaks filenames across admins** — `app/api/admin/notifications/import-status/route.ts:42` returns every admin's `originalFilename`; also can't distinguish hung-but-heartbeating from healthy. → Confirm intended; surface "last phase change" age.
- **Worker hard-crash reclaim is slow** — detached job promises (`worker/jobs.ts:43`, `keepaJobs.ts:209`) vanish on SIGKILL; orchestrator burns its full poll budget (6h import / 24h keepa) before reclaiming. → Startup sweep that fails stale `importStartedAt` older than the lock window.
- **Digest mid-chunk crash can re-send** — `sendWeeklyDigest.ts:112` — if the worker dies after Resend accepts a batch but before `markOne`, a resume re-sends (≤100 users, hard-crash only). → Note/accept for first users.
- **Verify FK cascades on `users` delete** — `webhooks/clerk/route.ts:66` relies on `ON DELETE CASCADE` for watchlist/digest/saved-view rows; if any FK isn't cascade, the delete throws or orphans. → Verify.
- **`/app` uses raw `<a>` not `<Link>`** (`app/app/page.tsx:14,20`) — full reloads. And the home redirect target is duplicated between `page.tsx:8` and `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` — keep in sync. → Swap to `Link`.

---

## Already solid (no action — confidence builders)

- **Security / multi-user:** no cross-user leakage, no missing auth, no injection. All user data `userId`-scoped (body/param ids only ever in `AND id=? AND userId=?`), middleware is a fast redirect with server-side re-checks in both protected layouts, all 18 admin routes `requireAdmin`-gated, Clerk webhook verifies svix signature, explorer SQL interpolates only allow-listed enums/columns with every value parameterized + `q` LIKE-escaped, no secrets in the client bundle.
- **Data pipeline:** ingestion/refresh is well-hardened — kcs stage-and-swap with post-commit ANALYZE, CAS-style status flips, refresh runs *after* mark-imported so a flaky refresh can't corrupt import state; email senders fail-soft on missing key / per-recipient errors; digest idempotent at (week,user).
- **App correctness:** empty states are guiding (watchlist/explorer/CB), API routes uniformly validate + enforce caps + return typed errors, pagination/jump-to edges handled, explorer queries bounded with 45s/115s statement timeouts + `maxDuration`.

## Deferred to the dogfooding pass

Visual consistency, spacing/hierarchy, mobile/responsive behavior, real click-through of each flow, and screenshot evidence — needs the live site in a browser (authenticated). Worth doing once the P0/P1 structural items land.

---

## Larger pre-launch workstreams (product-owner items)

These are epics, not line-item fixes — each is its own mini-project. Scope + how to de-risk:

### A. Real marketing / support website
The public surface is one bare page today. Build it out as routes in the existing `app/(marketing)/` group — same Next app, no separate site needed. (This supersedes/absorbs the P1 "marketing landing" item.) Recommended pages:
- **Home** — value prop, what it does, 2–3 feature highlights with screenshots, primary CTA.
- **Pricing** — even as "Free during beta," stand it up now so the paid transition (workstream C) is a content change, not new plumbing.
- **Help / Guide (or FAQ)** — how to use Explorer / Watchlist / Category Builder, what "SFR" means, common questions. Doubles as onboarding.
- **About** — who/why; trust signal.
- **Contact / Support** — at minimum a support email; ideally a form.
- **Terms of Service** + **Privacy Policy** — **required** before real users, and a hard prerequisite for payments (C) and for Stripe/Clerk. Include a "not affiliated with Amazon" disclaimer given the data source.
- *(Later/nice)* Changelog, Blog (SEO).

**Must-have-for-launch subset:** Home, Help/FAQ, Contact, ToS, Privacy. Pricing lands with C.

### B. Finalize Resend for real email
Emails fail-soft today and target test users. To send to real users:
- Verify a sending **domain** in Resend (SPF/DKIM/DMARC DNS records); move the from-address off the test sender to `@yourdomain`.
- Confirm Resend plan limits cover the digest fan-out.
- Compliance: unsubscribe flow exists (good) — ensure every digest email carries it + a physical mailing address (CAN-SPAM); add the unsubscribe-token expiry (P1 above).
- Test inbox-vs-spam deliverability to the major providers.

Mostly config + DNS, not code — but it blocks the digest feature for real users.

### C. Payments / paid tiers (later — but architect now)
No paid users at first, but set the seam now so free→paid is additive, not a refactor:
- Decide the billing layer: **Clerk Billing** (native to the existing Clerk auth, lower friction) vs **Stripe** direct (Checkout + Billing + webhooks).
- Introduce a **plan / entitlement seam now** — a `plan` field on the user (default `free`) + a small `can(user, feature)` check at the gates, even if everything returns `true` today. Then paid gating is flag-flips, not new plumbing.
- Don't bake in "unlimited access" assumptions — the existing `MAX_*` limits are the natural place tiers will differ.
- ToS/Privacy + a real Pricing page (A) are prerequisites.

No code yet — the goal is just not to paint into a corner. Decision needed first: billing layer + what's gated vs free.

### D. Full design / UI overhaul
The app is functional but utilitarian Tailwind. This is the deferred visual/dogfooding work, expanded:
- Establish a lightweight **design system first** (type scale, color, spacing, components) as a `DESIGN.md` source of truth, then apply consistently — rather than ad-hoc restyling.
- Covers: marketing pages (A), app chrome (nav/header), the dense data tables (explorer/watchlist), forms, and the empty/loading/**error** states (design the Batch 1 ones on-brand), plus mobile/responsive.
- **The real favicon/branding lives here** (moved out of Batch 1 — it's a brand asset, not boilerplate).
- Best done *after* Batch 1 lands so we style real states. Sequence: design system → marketing pages → app polish.

## Suggested batching

- **Batch 1 — structural quick wins (knocks out 4 of 5 P0s, ~an afternoon):** `error.tsx` + `global-error.tsx` + `not-found.tsx`, the detail-page history error boundary, watchlist `loading.tsx`, real favicon. Mostly boilerplate; big perceived-robustness jump.
- **Batch 2 — user-facing feedback + first-impression:** ⭐ star error/cap feedback, CB drill/add error states, page-past-end message, landing value-prop + CTA, SFR gloss, sign-in/up titles, `/app` orientation.
- **Batch 3 — reliability & abuse (ops):** Keepa fetch timeout, Clerk webhook try/catch, monthly-SFR timeout email, rate-limiting (bulk/creates/broad/public taxonomy), unsubscribe-token expiry, dead refresh event.
- **Batch 4 — hardening (P2) + the dogfooding visual pass.**

**Operational pre-launch checklist (not code):** verify/rotate prod credentials in `.env.local` if real (Clerk/Neon/R2/Resend/Keepa), confirm FK cascades on `users`, decide always-on Neon floor (cost vs cold).
