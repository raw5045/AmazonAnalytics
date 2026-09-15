# Daily Digest — Weekly and Monthly Active Users — Design Spec

**Date:** 2026-09-15
**Status:** Approved (owner picked trailing windows and an unchanged subject in chat)
**Scope:** Body-only change to the daily admin digest (`lib/notifications/abuseDigest/`).
The existing "Active users" section becomes "Daily active users", followed by two new
sections, "Weekly active users" and "Monthly active users", with the same per-user
columns over trailing 7- and 30-day windows. No schema change, no new counters, no
subject-line change, no flag/threshold change. The admin preview page renders the same
built HTML and therefore shows the new sections without edits.

## Motivation

The digest's per-user table is the owner's only view of usage, and a single ET day is
too noisy to judge whether beta users are coming back. DAU/WAU/MAU on the same table
answers "who is actually using it" at a glance, ahead of the eCommerceFuel launch wave.

## Decisions (owner-confirmed)

| Question | Decision |
|---|---|
| Windows | **Trailing** 7 and 30 ET calendar days ending on the digest day (inclusive), e.g. digest day 2026-09-15 → weekly 09-09..09-15, monthly 08-17..09-15. Not calendar week/month |
| Subject | **Unchanged.** The pulse stays `N signups · N active · N reads` (daily numbers) |
| Definition of active | Same as today: any counter row or creation in the window. Stats are summed across the window's days |
| Flags | Unchanged — evaluated on the daily list only |
| Quiet day | The daily "All quiet" line stays; the weekly and monthly sections always render (with a "No user activity in this window." fallback) |
| Row cap | Same `ACTIVE_USER_ROW_CAP` (25) per table, sorted by reads desc, "…and N more active users" line |

## Data

`user_activity_daily` keeps one row per (user, ET day, metric) and is never pruned, with
an index on `day`; a window is `SUM(count) GROUP BY user_id, metric` over `day BETWEEN
start AND end`. Creation counts (watchlist adds, saved views, custom categories) already
filter `created_at`/`added_at` by an ET-day timestamp window; the same predicates take a
wider `[start 00:00 ET, end+1 00:00 ET)` range. Counters exist since 2026-07-13, so the
30-day window is fully populated from the first send.

## Part 1 — Date helper (`lib/activity/etDay.ts`)

```ts
/** `day` ('YYYY-MM-DD') shifted by `deltaDays` calendar days. Pure UTC-space arithmetic. */
export function addDays(day: string, deltaDays: number): string;
```

Weekly start = `addDays(day, -6)`, monthly start = `addDays(day, -29)`.

## Part 2 — Types (`lib/notifications/abuseDigest/types.ts`)

```ts
export interface ActiveUsersWindow {
  startDay: string;            // first ET day, inclusive
  endDay: string;              // last ET day, inclusive (= the digest day)
  users: PerUserActivity[];    // one row per active user, sorted by reads desc
}
// AbuseDigestStats gains:
weeklyActiveUsers: ActiveUsersWindow;   // trailing 7 days
monthlyActiveUsers: ActiveUsersWindow;  // trailing 30 days
```

`activeUsers` (the daily list) keeps its name so `evaluateFlags`, `sendAbuseDigest`'s
result shape, and their tests are untouched.

## Part 3 — Loader (`loadAbuseDigestData.ts`)

Extract `loadActiveUsersForWindow(startDay, endDay)` from the current per-day code:
summed counters (`GROUP BY user_id, metric` — preserves `assemblePerUserActivity`'s
one-row-per-(user, metric) invariant), the three grouped creation counts over the
wider timestamp window, identity lookup for the involved ids, then
`assemblePerUserActivity`. Call it three times: `(day, day)`, `(addDays(day,-6), day)`,
`(addDays(day,-29), day)`. The daily result is byte-for-byte what the current code
produces (a one-day SUM equals the single row's count).

## Part 4 — Builder (`buildAbuseDigestEmail.ts`)

- Extract the per-user table (HTML) and the per-user lines (text) into helpers shared
  by all three sections; the daily section's output is unchanged apart from the heading.
- Headings: `Daily active users (N)`; `Weekly active users (N) · Sep 9 – Sep 15`;
  `Monthly active users (N) · Aug 17 – Sep 15`. Ranges formatted from the window's
  `startDay`/`endDay` as `Mon D` (string-based, no timezone math).
- Weekly and monthly sections render after the daily block in both text and HTML,
  including on quiet days.
- Subject and `totalReads` unchanged.

## Testing

- `lib/activity/etDay.test.ts` — `addDays` across month/year boundaries, a leap day,
  −6/−29 shifts, and a zero shift.
- `buildAbuseDigestEmail.test.ts` — fixtures gain the two windows; new cases: all three
  headings with counts and date ranges (HTML and text) and the old heading gone; subject
  unchanged with windows populated; weekly/monthly still render on a quiet day; the
  "no activity in this window" fallback; per-window row cap.
- `evaluateFlags.test.ts` — fixture gains the two windows (type completeness only).
- Loader: no DB unit test (as today); verified read-only against prod with a throwaway
  script printing DAU/WAU/MAU for yesterday, then on the admin preview page after deploy.

## Ship checklist (owner-gated)

1. Typecheck + full suite green; prod probe numbers plausible (WAU ≥ DAU, MAU ≥ WAU).
2. Push authorization (`scripts/checkActiveJobs.ts` first — the digest runs on the
   Railway worker, which restarts on push).
3. Owner opens `/admin/abuse-digest` (Yesterday) and confirms the three sections, or
   hits Send now.
