# Explorer Avg Price / Avg Reviews Sorts — Null-Key Exclusion (Design + Decision Record)

**Date:** 2026-09-22
**Status:** Implemented on branch `claude/pensive-agnesi-c6a7c5` (unpushed; owner review)
**Scope:** `lib/explorer/buildQuery.ts` sort keys `avg_price_asc|desc`, `avg_reviews_asc|desc`
and their count guards + UI hints. No schema change, no DDL, no worker change. The
watchlist is untouched (it never hides rows).

## Problem

`kcs_avg_price_idx` / `kcs_avg_reviews_idx` (migration 0030, physical-table twins in 0041)
are plain ASC btrees on `(current_week_end_date, avg_*)`. Postgres pathkey-matches a forward
scan of such an index as `ASC NULLS LAST` and a backward scan as `DESC NULLS FIRST` — never
`DESC NULLS LAST`, which is what `buildOrderBy` emitted for the two `*_desc` keys. The planner
therefore fell back to a 2-worker Parallel Seq Scan over the 2.6M-row
`keyword_current_summary` feeding an on-disk external merge sort (≈197 MB per worker) for
every "Most avg reviews" / "Most expensive avg price" page. The Explorer's 45 s count / 115 s
row deadlines hid it. The research tool's equivalent sort had the same bug and was fixed in
`0e2f28f` (2026-09-21) by excluding null keys and ordering with a bare direction.

Read-only `EXPLAIN (ANALYZE, BUFFERS)` on production, default filters, page 1, 2026-09-22
(REPEATABLE READ READ ONLY, 60 s cap; cold pass then warm pass):

| Shape (before) | rows cold | rows warm | plan |
|---|---|---|---|
| `avg_reviews_desc` | **23,056 ms** | 2,687 ms | Parallel Seq Scan → external merge sort (`avg_reviews DESC NULLS LAST`) |
| `avg_price_desc` | **7,416 ms** | 2,750 ms | same shape |
| `avg_reviews_asc` (control) | 293 ms | 31 ms | Index Scan `kcs_avg_reviews_idx` (forward scan = `ASC NULLS LAST`) |

## Options considered

**(a) Sort-driven null exclusion — chosen.** When the sort key is one of the four avg keys,
push `kcs.<col> IS NOT NULL` into the WHERE (rows AND counts) and order with a bare
`ASC`/`DESC`. With nulls excluded, NULLS placement cannot change the result set, only the
plan — and the existing ASC index now serves both directions. Zero DDL, verifiable
end-to-end in-session, and the same population rule the research tool already documents
("nulls are never ranked").

**(b) `DESC NULLS LAST` index pair — rejected.** It keeps nulls visible at the end of the
list (where nobody pages on a "most reviews" sort) at the cost of four new indexes on a
2.6M-row table (two per column: the weekly refresh RENAME-swaps the live and stage tables, so
every kcs index needs a physical-table twin — see 0041), weekly maintenance on the refresh
INSERT, and owner-gated production DDL that could not be applied or probed in this session.
It also diverges the Explorer's population from the research tool under the same sort, and it
would carry the identical planner trade-off recorded below (an index-ordered walk becomes
eligible either way).

## Decisions

| Question | Decision |
|---|---|
| Which directions | **All four keys, both directions.** `*_asc` was already index-served, but excluding nulls only under `desc` would make the result set and the footer total change when the user flips direction. One rule: sorting by a value hides keywords without one (matches the `reviewsMin/Max` "unknown ≠ low" rule and the imp/decline eligibility precedent). |
| Where the predicate lives | `pushKcsPredicates` (one shared WHERE builder → rows + counts, both query paths). Binds no args, so the `countArgs` prefix invariant holds. Redundant next to an explicit reviews bound, harmless. |
| Precomputed totals | New `sortHidesRows(sort)` = `sortUsesVolumeDelta(sort) \|\| sortNullKeyColumn(sort) !== null`; all three `queryTotals` guards consult it, so meta/facet totals are never served under a row-hiding sort (they would overcount). |
| Watchlist | Unchanged: `fetchExplorerRowsByIds` keeps `NULLS LAST` (rows are never hidden there; an id-list fetch needs no index-ordered scan). Comment added. |
| UI hint | Sidebar: one line under the Sort select for every row-hiding sort (`SORT_HINTS`, includes imp/decline so the rule is stated in one place). Results table: the Avg price / Avg reviews header tooltips gain a sentence; the `volSortHidesIneligible` prop is renamed `sortHidesIneligible` since it now governs both the Δ and the avg headers (explorer: "hides"; watchlist: "sort last (shown as —)"). |
| CSV export | Inherits the rule via `runExplorerQuery` (no separate SQL). An export sorted by an avg key no longer carries value-less rows at its tail. |

## Verification

- `lib/explorer/buildQuery.test.ts`: canonical-string tests for all four keys on the legacy
  and q paths (predicate in rows + count, bare direction, no `NULLS LAST`, no bound args,
  other sorts untouched, composition with a reviews bound), plus `sortNullKeyColumn` /
  `sortHidesRows` tables. Two pre-existing assertions of the old `NULLS LAST` shape updated.
  Red observed before green (25 failing tests, each for the expected reason).
- `lib/explorer/queryTotals.test.ts`: the three guards stand down under each avg sort.
- `app/(app)/explorer/FilterSidebar.test.tsx`, `ResultsTable.test.tsx` (new): hint copy on
  the explorer and the watchlist variant.
- `pnpm test`: 102 files / 1174 tests green. `pnpm eslint` on every changed file: clean.
  `pnpm typecheck`: only the two pre-existing `tests/integration/*.test.ts → ./helpers` errors
  (that helper is untracked in the main checkout and absent from git; unrelated).

Production re-probe after the change (same harness, `scripts/probeExplorerAvgSort0922*.ts`,
untracked):

| Shape (after) | rows cold | rows warm | plan |
|---|---|---|---|
| `avg_reviews_desc` | **48 ms** | 30 ms | Index Scan Backward `kcs_avg_reviews_idx`, Index Cond `week = $1 AND avg_reviews IS NOT NULL` |
| `avg_price_desc` | **32 ms** | 29 ms | Index Scan Backward `kcs_avg_price_idx` |
| `avg_reviews_asc` | 28 ms | 30 ms | Index Scan (forward), unchanged |
| counts (all three) | 30–89 ms | 30–34 ms | bail-out `LIMIT 10001`, unchanged |
| `avg_reviews_desc` + `q=hair` | 386 ms | 515 ms | trigram bitmap + top-N heapsort (was 914 / 558 ms) |
| broad category Apparel (444k kw) + `avg_reviews_desc` | 228 ms | 61 ms | avg-index walk, 3.7k rows filtered |
| broad category Apparel + `avg_price_desc` | 788 ms | 372 ms | avg-price-index walk, 53k rows filtered |
| leaf #50 (2,676 kw) + `avg_reviews_desc` | 348 ms | 47 ms | `kcs_cat_cover_idx` + quicksort (same plan as `asc`) |
| leaf #500 (718 kw) | 807 ms | 46 ms | `kcs_leaf_path_idx` + top-N heapsort |
| leaf #5000 (67 kw) | 116 ms | 27 ms | `kcs_leaf_path_idx` + quicksort |

(Index names show the `kcs_stage_*` twins on the live table this week — expected after the
RENAME swap; see 0041.)

## Known trade-off (accepted, not mitigated)

For the single most populous leaf (≈11k keywords) + `avg_reviews_desc`, the planner now
prefers walking the avg index backward with a heap filter on the leaf path, misestimates how
soon it will find 101 matches (7.4k estimated, 203k rows discarded) and lands at
**2,478 ms cold / 902 ms warm** — versus 608 ms / 54 ms before via `kcs_cat_cover_idx` +
sort, when the `NULLS LAST` request made the avg index ineligible. Every smaller leaf probed
keeps the sort plan, and option (b) would have exposed exactly the same choice. This stays
well inside the deadlines and only touches the few largest leaves; if it ever matters, the
established remedy is to extend the 0046 covered path (`categoryPathIsCovered`) to the avg
sorts rather than to steer the planner from SQL.

## Out of scope

- `title_gap` orders `ASC NULLS FIRST` on the loose count column, which has no index
  (`kcs_title_match_idx` covers the strict column only) — a separate, pre-existing seq-scan
  shape.
- The research tool's `wordCount` sort (no index; documented in the MCP guide).
