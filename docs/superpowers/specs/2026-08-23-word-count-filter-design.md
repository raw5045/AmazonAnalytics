# Word-Count Range Filter — Design Spec

**Date:** 2026-08-23
**Status:** Approved (beta-user request; design confirmed with the owner)
**Scope:** Explorer-only filter on the keyword's word count, computed at query
time from `kcs.search_term_normalized`. Second run of the range-filter clone
pattern (see `2026-07-20-avg-reviews-filter-design.md`). No schema changes, no
refresh-time cost, no worker/email changes.

## Motivation

Beta-user request: filter by number of words so long-tail hunters can demand
"3+ words" (which long-tails have real volume?) and head-term hunters can
demand exactly one word. Composes with everything: "my category + under 500
reviews + 3+ words + best rank" is a query no competing tool expresses.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| Input shape | **Min + max**, both optional, inclusive. Owner's examples are normative: `1–1` = only single-word keywords; `5–blank` = five+ words; `blank–2` = at most two |
| Word definition | Space-separated tokens of `search_term_normalized` (single-spaced by `normalizeForMatch`). Hyphenated terms ("anti-aging") count as ONE word — documented quirk |
| Zero | Rejected — every keyword has ≥1 word; inputs and parser floor at 1 (`parsePositiveInt`, unlike the reviews filter's zero-admitting parser) |
| Storage | **None.** Query-time expression; zero weekly-processing cost. Upgrade path if probes ever strain: stored column computed during the kcs rebuild (measured cost of that class of change: ~nothing) — NOT built now |
| NULL normalized | Rows lacking normalized text (legacy edge, ~zero rows post-0037 backfill) drop out while the filter is active — consistent with the reviews filter's NULL semantics |
| Process | Inline TDD implementation (pattern is established) + prod EXPLAIN probes + one independent code-review pass before ship |

## Part 1 — Expression + predicate (`lib/explorer/buildQuery.ts`)

Word count as a SQL expression (spaces + 1 on the single-spaced normalized
term):

```sql
(length(kcs.search_term_normalized) - length(replace(kcs.search_term_normalized, ' ', '')) + 1)
```

Exported as a helper `wordCountExpr(alias)` (mirroring `volumeDeltaExpr`'s
alias pattern) so tests pin the exact string once. Two conditional predicates
in `pushKcsPredicates`, directly after the reviews pushes:

```sql
<expr> >= $min   -- when wordsMin !== null
<expr> <= $max   -- when wordsMax !== null
```

NULL `search_term_normalized` makes the expression NULL → row drops when a
bound is set (desired). Both query paths and rows+counts inherit via the
shared builder; clause order stays fixed so the countArgs-prefix invariant
holds.

## Part 2 — Types + parsing

- `ExplorerFilters` + `EXPLORER_DEFAULTS` gain `wordsMin`/`wordsMax:
  number | null` (defaults null).
- `parseExplorerFilters` reads `words_min`/`words_max` via the existing
  `parsePositiveInt` (floors at 1; garbage → null; never-500 contract).
- Min > max not cross-validated (0 rows) — matches rank + reviews behavior.

## Part 3 — Count guards (`lib/explorer/queryTotals.ts`)

All three shortcut guards (`canUseDefaultTotal`, `canUseCategoryFacet`,
`canUseLeafCategoryFacet`) gain `&& f.wordsMin === null && f.wordsMax ===
null`, unit-tested, so an active filter always falls through to a live count.

## Part 4 — Sidebar UI (`FilterSidebar.tsx`, `page.tsx`)

Card **"Word count"** directly below "Avg reviews (top-3)": Min / Max number
inputs (`min={1}`), same pending-state + Apply + Enter-to-apply flow, helper
text: *"Words in the keyword — try min 3 to hunt long-tail terms."*
`filtersAreCustomized` in page.tsx learns both fields.

## Part 5 — Saved views (`lib/savedViews/validation.ts`)

`filtersToSearchParams` emits `words_min`/`words_max` (typeof-number
guarded); `normalizeFiltersBlob` reads both with typeof-number checks; legacy
blobs → null. Round-trip + legacy tests.

## Part 6 — Performance verification (pre-ship, prod, read-only)

Owner explicitly wants the runtimes reported. `EXPLAIN (ANALYZE, BUFFERS)`
probes with real literals:

1. `words_min=3` + best rank (the long-tail hero query);
2. `words_min=1&words_max=1` + a volume sort (selective case);
3. stacked: `words_min=3` + `reviews_max=500` + a broad leaf path + best rank.

Acceptance: no Seq Scan on kcs; latencies in line with the reviews-filter
probes (sub-second warm for LIMIT paths; the 10k-capped count may scan more
on selective combos). Report actual numbers to the owner either way.

## Testing

- `parseFilters.test.ts`: parse both; 1 accepted; 0/garbage → null.
- `buildQuery.test.ts`: exact-string pin of `wordCountExpr`; predicates in
  rows AND count SQL on both paths; absent by default; the owner's two
  normative examples as literal cases (`words_min=1&words_max=1`,
  `words_min=5`); composes with a volume-delta sort.
- `queryTotals.test.ts`: guard falsity for either bound.
- `validation.test.ts`: round-trip + legacy-blob nulls.

## Non-goals

- No stored word-count column or index (upgrade path documented above).
- No presets dropdown (min/max expresses everything).
- No watchlist-loader, digest, or worker changes.
- No tokenization beyond space-splitting (hyphen quirk accepted).

## Ship checklist (owner-gated)

1. Inline TDD implementation, full suite + typecheck green.
2. Prod EXPLAIN probes run; timings reported to the owner.
3. Independent code-review pass; findings addressed.
4. Owner tries it live post-deploy (their two examples).
5. Push gate: checkActiveJobs, then push on explicit authorization.
