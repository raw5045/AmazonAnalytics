# /app Home → Straight to Explorer — Design Spec

**Date:** 2026-07-15
**Status:** Approved (brainstormed with the owner; "Straight to explorer" chosen over
light-refresh and real-dashboard options)
**Scope:** Remove the placeholder signed-in hub page at `/app` and land users directly
on the Keyword Explorer after sign-in/sign-up. `/app` stays alive as a redirect.

## Why

The hub at `app/app/page.tsx` is vestigial: it sits **outside** the `(app)` route
group (so it lacks the navy app header and still wears pre-reskin gray styling), and
its three navigation cards duplicate the app shell's TabNav exactly (Explorer |
Watchlist (N) | Category Builder, plus an Admin link for admins). The app header's
wordmark already links to `/explorer`. The only non-navigation content — a welcome
line and a two-sentence SFR explainer — is covered by the marketing Help page.
Landing on the explorer puts real data on screen immediately, and it is the page all
the keep-warm work optimized.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| Direction | **Eliminate the hub**; sign-in/sign-up land on `/explorer` |
| `/app` URL | Kept as a redirect to `/explorer` — **temporary (307), not permanent (308)**, because browsers cache 308s indefinitely and a future post-launch dashboard may reclaim `/app` |
| Dashboard idea | Parked for post-launch (not designed here) |
| SFR explainer / welcome copy | Dropped; `/help` already explains SFR. No first-run banner in the explorer |

## Changes

### 1. Routing

- **Delete** `app/app/page.tsx` (the directory's only file; remove the directory).
- **Add** a `redirects()` block to `next.config.ts` (currently an empty scaffold):

```ts
const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        // Old signed-in hub; the explorer is home now. Temporary (307) on
        // purpose: browsers cache 308s forever, and a future dashboard may
        // reclaim /app.
        source: '/app',
        destination: '/explorer',
        permanent: false,
      },
    ];
  },
};
```

Redirects resolve before the filesystem, so no page file is needed. A signed-out hit
on `/app` becomes 307 → `/explorer` → the `(app)` layout auth gate → `/sign-in` —
same outcome as today with one extra internal hop.

### 2. Entry points repointed (the complete list of `/app` references)

| File | Today | Change |
|---|---|---|
| `app/(marketing)/layout.tsx` (~line 55) | "Go to app" button `href="/app"` | `href="/explorer"` (label unchanged) |
| `app/(marketing)/page.tsx` (~lines 87–89) | signed-in visitors `redirect('/app')` | `redirect('/explorer')`, and update the adjacent keep-in-sync comment to name `/explorer` |
| `app/admin/layout.tsx` (~line 11) | non-admin authed users bounced to `/app` | bounce to `/explorer` |
| `app/robots.ts` | disallows `/app` | **no change** — still correct for a redirect |
| `middleware.ts` (line 8) | `'/app(.*)'` in the protected-route matcher | remove the entry — config redirects fire before middleware, so it would be dead code |
| `app/(marketing)/layout.tsx` (~line 6, comment) | "The signed-in → /app redirect lives only in the landing page" | say `/explorer` |
| `app/error.tsx` (~line 4, comment) | boundary coverage list names "/app landing" | drop it |
| `app/api/category-builder/tree/route.ts` (~line 6, comment) | "middleware protects only /admin, /app, /explorer" — already stale (watchlist + category-builder are matched too) | reword to the accurate post-change list |

**Amended 2026-07-15 during planning:** a broader grep (allowing `(`-suffixed matcher
patterns, which the original quote-bounded grep missed) found the last four rows
above: one real matcher entry in `middleware.ts` and three stale comments. No design
change — they complete the "complete list."

### 3. Environment

Flip both Clerk redirect targets from `/app` to `/explorer`:

- `.env.local` lines 32–33: `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/explorer`,
  `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/explorer` (uncommitted file; edited locally).
- Vercel production env: same flip (ship checkpoint). `NEXT_PUBLIC_*` values bake in
  at build time, so they take effect with the deploy the push triggers; the 307
  covers any ordering gap, so nothing breaks if env and deploy land out of order.

`.env.example` does not document these vars today; leave it as is.

## Ship checklist (owner-gated)

1. `npx tsx scripts/checkActiveJobs.ts` — confirm the worker is quiet, then request
   push authorization (standing convention).
2. Vercel: flip the two env vars in the production environment.
3. Push → deploy.
4. Clerk dashboard: confirm no path setting (e.g., Home URL / after-sign-in paths)
   still points at `/app`; fix to `/explorer` (or the bare domain) if one does.
5. Prod verification: sign in → lands on `/explorer`; marketing header "Go to app" →
   `/explorer`; stale `/app` bookmark → 307 to `/explorer`; signed-in visit to `/` →
   `/explorer`.

## Verification

- `pnpm typecheck`, `pnpm test`, `pnpm build` all green.
- Local (no auth needed — the redirect fires before auth): `curl -I localhost:3000/app`
  returns 307 with `location: /explorer`.
- Local signed-in-flow checks are skipped: localhost runs the dev Clerk instance
  (post-cutover wrinkle), so sign-in landing is verified on prod (ship checklist #5).
- Grep proves no remaining `/app` route references — including `(`-suffixed matcher
  patterns — outside `robots.ts`'s deliberate disallow and docs.

## Non-goals

- No dashboard build-out now (parked for post-launch; `/app` reclaimable thanks to 307).
  Reclaim note: the redirect source is exactly `/app` and the middleware matcher entry
  is gone, so a future dashboard with sub-routes must restore its own matcher entry
  (or live inside the `(app)` route group's auth gate).
- No first-run/onboarding banner in the explorer.
- No change to sign-out destination (`afterSignOutUrl="/"`), robots policy, or the
  TabNav's last-explorer-URL memory.
