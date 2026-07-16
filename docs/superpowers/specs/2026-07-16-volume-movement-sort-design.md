# Volume-Based Movement Sorts — Design Spec

**Date:** 2026-07-16
**Status:** Approved (brainstormed with the owner; all decisions below owner-picked)
**Scope:** Re-point the explorer's "Biggest improvement (window)" / "Biggest decline
(window)" sorts from SFR-rank deltas to estimated-search-volume deltas, with matching
table-column behavior. No data-pipeline changes.

## Why

SFR is an ordinal rank, and estimated volume follows a power-law of rank — so equal
rank deltas mean wildly different real-search changes depending on where they happen.
A keyword going 2.5M → 1M tops today's improvement sort while gaining almost no
searches; 500 → 300 is a flood but ranks far below it. Sorting by estimated-volume
delta measures what actually matters. Bonus: deep-tail extrapolation noise (where the
volume model is least trustworthy) produces tiny absolute deltas, so it self-suppresses
instead of dominating.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| Replace or add? | **Replace in place** — `imp` / `decline` keep their keys; existing saved views silently adopt volume semantics; sidebar stays at 9 sorts |
| Delta measure | **Absolute** monthly-volume delta (current − N weeks ago). Percent-change is an explicit non-goal (possible future preset) |
| Labels | `Biggest improvement (search volume)` / `Biggest decline (search volume)` (verbatim) |
| NULL lookback volume | **Two cases, split by `rank_Nw_ago`**: unranked-then → treat prior volume as **0** (a nothing → 20k/mo newcomer IS a +20k improvement — the "rising demand" signal); ranked-then but no calibration fit for that week → delta is **unknowable → row hidden under these two sorts only** (coalescing to 0 would fabricate phantom improvements for stable keywords) |
| Table columns | **Context-swap**: when sort ∈ {imp, decline}, the window column (rank N wks ago) becomes **volume N wks ago** and Δ becomes the **volume delta** — current / prior / delta read left-to-right with the existing "Est. monthly vol." column; zero net new columns. All other sorts keep today's exact layout |
| Indexes | Migration **0044**: 5 partial expression indexes (one per window) on live + stage tables per the index-twin convention |

## Sort semantics

For the selected window `N ∈ {1w, 4w, 13w, 26w, 52w}` (kcs columns exist for all):

```sql
volume_delta_N = estimated_monthly_volume_current
               - CASE WHEN rank_Nw_ago IS NULL THEN 0
                      ELSE estimated_monthly_volume_Nw_ago END
```

- `imp`  → `ORDER BY volume_delta_N DESC`
- `decline` → `ORDER BY volume_delta_N ASC`
- **Eligibility predicate** (applied as WHERE under these two sorts only):
  `estimated_monthly_volume_current IS NOT NULL AND (rank_Nw_ago IS NULL OR
  estimated_monthly_volume_Nw_ago IS NOT NULL)` — i.e. the delta is computable.
  Rows failing it (no current fit, or ranked-then with no historical fit) are
  excluded under these sorts; every other sort is untouched. Because the predicate
  guarantees non-NULL deltas, no NULLS FIRST/LAST handling is needed and one plain
  partial index per window serves both directions (forward = decline, backward = imp).

## Query changes (`lib/explorer/`)

- `buildQuery.ts`: add a window → volume-delta expression map beside
  `WINDOW_TO_IMPROVEMENT_COLUMN`; `buildOrderBy` cases `imp`/`decline` emit the
  volume expression (inner query) and a stable `volume_delta` alias (outer/CTE query,
  mirroring the existing `k.improvement` pattern); add the eligibility predicate to
  the WHERE chain when sort ∈ {imp, decline}; SELECT gains
  `volume_delta` and `volume_prior` (the CASE'd prior volume) aliases so the table
  can render them. The existing `improvement` alias stays (other consumers unchanged).
- `runQuery.ts` / `countExplorerMatches`: the streamed **total count and `hasNext`
  must apply the same eligibility predicate when these sorts are active** so counts
  match visible rows.
- `parseFilters.ts` / `lib/savedViews/validation.ts`: **no changes** — keys, URL
  params, and saved-view payloads are untouched.
- Row type: explorer row gains nullable `volumeDelta` / `volumePrior` fields
  (populated under every sort — they're cheap SELECT expressions — so the table can
  swap columns purely client-side on the current sort key).

## Migration 0044 (raw SQL, gated apply script per convention)

Five partial expression indexes, e.g. for 4w:

```sql
CREATE INDEX kcs_vol_delta_4w_idx ON keyword_current_summary
  (((estimated_monthly_volume_current
     - CASE WHEN rank_4w_ago IS NULL THEN 0
            ELSE estimated_monthly_volume_4w_ago END)))
  WHERE estimated_monthly_volume_current IS NOT NULL
    AND (rank_4w_ago IS NULL OR estimated_monthly_volume_4w_ago IS NOT NULL);
```

…and the same for 1w/13w/26w/52w, **plus stage-table twins** (naming per the
migration-0041 twin convention — the plan confirms exact names against the live DB;
the swap renames tables, so twins must exist on both sides or the sort goes
unindexed every other week). Drizzle can't declare expression indexes — schema file
gets a comment pointing at 0044 (same pattern as the GIN).

Expression indexes are only usable when the query's ORDER BY expression matches the
index expression **textually after normalization** — the plan keeps one shared
SQL-string constant per window used by both the migration and `buildQuery` to make
drift impossible.

## UI changes (`app/(app)/explorer/`)

- `FilterSidebar.tsx`: the two SORTS labels (values unchanged).
- `ResultsTable.tsx`: when `currentSort` ∈ {imp, decline}:
  - Window column header → `{WINDOW_LABEL} vol.` with tooltip "Estimated monthly
    volume N weeks ago"; cell renders `volumePrior` formatted like Est. monthly
    vol.; renders **0** (tooltip: "not ranked that week") when the keyword was
    unranked at the window start.
  - Δ header → `Δ vol.`, tooltip updated to: sorts by search-volume change in the
    selected window; keywords whose volume can't be estimated for the comparison
    week are hidden under this sort. Cell renders signed `volumeDelta` with the same
    green/red movement coloring the rank Δ uses today.
  - Sort keys on the header (`imp`/`decline`, first click = improvements) unchanged.
- Every other sort: today's exact layout (rank-ago + rank Δ). The watchlist table
  shares `ResultsTable`, so behavior is identical there wherever these sorts are
  reachable.

**Amended 2026-07-16 during planning:** the watchlist's by-IDs loader
(`fetchExplorerRowsByIds`, a deliberate projection duplicate) gets the same aliases
and volume ORDER BY, but **without the eligibility exclusion** — it sorts
non-computable rows last (NULLS LAST) instead of hiding them. Hiding a user's own
watched keywords would read as data loss, and the exclusion's perf/count rationale
(partial indexes, count parity) doesn't apply to a small explicit-ID set. The Δ vol.
cell renders an em-dash for those rows. Also for precision: the `1w` window's rank
discriminator column is `prior_week_rank` (kcs has no `rank_1w_ago`).

## Performance (owner-raised, resolved during brainstorming)

- **Filtered queries:** unchanged shape — filters select first, the subset sort costs
  one extra column read + subtraction per row. Immaterial.
- **Unfiltered/broad:** index-ordered scan via the partial indexes (≤ ~51 entries
  read). Today's `DESC NULLS LAST` rank sort may not even use its index cleanly, so
  this likely matches or beats it.
- **Planner trap** (LIMIT + ORDER BY picking the sort index over selective filters —
  the `?page=99999` failure class): verification includes EXPLAIN runs with and
  without filters, both directions, via a `verifyExplorerCtePlan`-style script.
- **Refresh cost:** the 5 partial bigint btrees ride the stage-table bulk INSERT.
  Owner reports the refresh currently runs **3+ hours** (the code comment's ~30 min
  is stale), so a few added minutes is proportionally noise; `import_phase_timings`
  reports the exact delta on the first post-ship import. Escape hatch if it ever
  matters: drop-before-INSERT + one-shot post-load build, the pattern the trigram
  GIN already uses. Refresh is stage+swap, so none of this is user-facing.
- **Neon cold layers:** first use after idle may pay a one-time cold read on the new
  indexes; if this sort becomes a daily driver, add it to the existing keep-warm
  sweep (out of scope here).

## Verification

- Unit: `buildQuery` ORDER BY + predicate emission per window/direction; count/rows
  parity under sort+filters; `volumePrior`/`volumeDelta` alias correctness incl. the
  unranked→0 case (TDD on the pure builders).
- `EXPLAIN` script: both directions, unfiltered + category-filtered + q-filtered,
  proving partial-index usage and no planner-trap regressions.
- Visual E2E (localhost): column swap in/out, 0-prior newcomer rows, coloring,
  labels; saved view with `imp` loads and sorts by volume.
- Ship gates as usual: full suite green, checkActiveJobs, owner push, migration 0044
  applied via gated script (owner-confirmed DDL), prod spot-check.

## Non-goals

- No percent-change preset (future option).
- No changes to the jump/Movement **filters** (already metric-aware), the refresh
  pipeline's computations, the detail page, or the weekly digest.
- No keep-warm additions for these indexes (revisit if the sort becomes a landing
  default).
