# Avg-Reviews Range Filter — Design Spec

**Date:** 2026-07-20
**Status:** Approved (brainstormed with the owner)
**Scope:** Explorer-only filter on `kcs.avg_reviews`. A mechanical clone of the
existing Rank range filter through the full stack. No schema changes, no new
indexes, no worker/email changes.

## Motivation

`avg_reviews` (mean review count across a keyword's top-3 clicked products,
Keepa-fed) is already a displayed, sortable, indexed column — but not
filterable. The owner's use case: *"all keywords in my category with avg
reviews under 500, sorted by best (lowest) SFR"* — a low-competition research
query the explorer cannot express today. A range filter composes with every
existing sort (rank, volume, Δ-volume, price, reviews) and all category/text
filters.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| Input shape | **Min + max range**, both optional, inclusive bounds — mirrors the Rank range card ("under 500" = max only) |
| Scope | **Reviews only.** The identical avg-price filter was offered and declined for this arc (same pattern later if demand shows) |
| NULL semantics | Active filter **excludes** keywords whose top-3 products lack review data (SQL comparison drops NULLs naturally). Unknown ≠ low. Sidebar helper text says so |
| Zero bounds | **0 is a legal bound** (`reviews_max=0` = zero-review niches, useful for new-product hunting). Requires a `parseNonNegativeInt` helper — the existing `parsePositiveInt` rejects 0 |
| min > max | Not cross-validated — yields 0 rows, matching how the existing rank range behaves |
| URL params | `reviews_min` / `reviews_max` (naming mirrors `rank_min`/`rank_max`) |
| Approach | First-class filter through the full stack (parser → builder → count guards → sidebar → saved views). A "lite" version was rejected: count guards that don't know the filter would serve the unfiltered precomputed total over filtered rows — a lying result count |

## Part 1 — Types + parsing (`lib/explorer/types.ts`, `parseFilters.ts`)

- `ExplorerFilters` gains `reviewsMin: number | null` and
  `reviewsMax: number | null`; both `null` in `EXPLORER_DEFAULTS`.
- New helper `parseNonNegativeInt(value)`: integer ≥ 0, else `null`
  (sibling of `parsePositiveInt`; used only by the reviews params).
- `parseExplorerFilters` reads `reviews_min` / `reviews_max` with it.
  Invalid/garbage values fall back to `null` silently, per the parser's
  never-500 contract.

## Part 2 — Query predicate (`lib/explorer/buildQuery.ts`)

Two conditional pushes in `pushKcsPredicates` (the shared WHERE builder):

```sql
kcs.avg_reviews >= $min   -- when reviewsMin !== null
kcs.avg_reviews <= $max   -- when reviewsMax !== null
```

Because `pushKcsPredicates` feeds both query paths (trigram/text-search CTE
and the default path) and both rows + count SQL, one change covers
everything. No SELECT changes — `avg_reviews` is already returned and
displayed. Composes with all sorts including the Δ-volume sorts (their
partial indexes are walked in order; the reviews predicate applies as a
heap filter).

## Part 3 — Count guards (`lib/explorer/queryTotals.ts`)

`canUseDefaultTotal`, `canUseCategoryFacet`, and `canUseLeafCategoryFacet`
each gain `&& f.reviewsMin === null && f.reviewsMax === null` so an active
reviews filter always falls through to a real count instead of the
precomputed totals. Unit-tested: either bound set ⇒ all three return false.

## Part 4 — Sidebar UI (`app/(app)/explorer/FilterSidebar.tsx`, `page.tsx`)

- New card **"Avg reviews (top-3)"** directly below the Rank range card:
  two number inputs (Min / Max), same pending-state + Apply flow as rank
  (`reviewsMin`/`reviewsMax` pending keys; empty input ⇒ param omitted).
- Helper text under the inputs: *"Excludes keywords without review data."*
- `page.tsx`'s active-filter check adds both fields so the
  filters-active affordance reflects the new filter.

## Part 5 — Saved views (`lib/savedViews/validation.ts`)

Parse + serialize the two fields exactly as `rankMin`/`rankMax` are handled
(typeof-number guard on parse; `String(...)` into `reviews_min`/
`reviews_max` on serialize). Legacy saved-view blobs lack the keys and
parse to `null` — no migration, no compatibility risk.

## Part 6 — Performance verification (pre-ship, prod, read-only)

`EXPLAIN (ANALYZE, BUFFERS)` probes with **real literals** (vol-sort arc
lesson: generic-param probes hide planner traps) on the worst realistic
combos:

1. `reviews_max=500` + sort best rank, no category filter (broadest case);
2. same + one broad department path filter;
3. `reviews_max=500` + Δ-volume improvement sort (4w).

Expected plans: rank-index walk with heap filter, or bitmap on the existing
`kcs_avg_reviews_idx (current_week_end_date, avg_reviews)` for selective
bounds; Δ-vol partial-index walk + heap filter for (3). Acceptance: no
seq-scan + full sort on the ~4M-row table; warm latency in line with
existing filtered queries. `kcs_avg_reviews_idx` already exists in prod and
survives the weekly refresh (proven by the live avg-reviews sort) — no DDL.

## Testing

- `parseFilters.test.ts`: both params parsed; `0` accepted; negative /
  non-numeric → null; defaults null.
- `buildQuery.test.ts`: canonical-string pins — predicates present in rows
  SQL **and** count SQL on both query paths when set; absent by default.
- `queryTotals.test.ts`: guard falsity when either bound is set.
- `lib/savedViews` tests: round-trip serialize→parse preserves the fields;
  legacy blob without keys → nulls.

## Non-goals

- No avg-price filter (declined this arc; identical clone if wanted later).
- No `least_reviews`/`most_reviews` filter variants.
- No watchlist filtering (`fetchExplorerRowsByIds` does sort parity only).
- No digest/email/worker/refresh changes; no DDL or new indexes.
- No generic numeric-filter registry (YAGNI at one filter).

## Ship checklist (owner-gated)

1. Implement via subagent-driven-development (fresh implementer per task,
   two-stage reviews), TDD throughout.
2. Full typecheck + test suite green.
3. Prod EXPLAIN probes (Part 6) reviewed.
4. Owner tries the filter in the explorer UI (localhost or prod preview).
5. Push gate: `scripts/checkActiveJobs.ts` first, then push on explicit
   authorization.
