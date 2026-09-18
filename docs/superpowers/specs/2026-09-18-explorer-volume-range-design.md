# Explorer Search-Volume Range Filter — Design Spec

**Date:** 2026-09-18
**Status:** Approved (design agreed in chat; owner asked for a Rank | Volume
toggle on the existing Rank range card, mirroring the Movement card)
**Scope:** Explorer-only filter on `kcs.estimated_monthly_volume_current`,
exposed as a metric toggle on the Rank range card. Same full-stack shape as
the avg-reviews filter (parser → builder → count guards → sidebar → saved
views → export). No schema change, no DDL (`kcs_est_vol_idx` has existed
since migration 0027), no worker/email changes.

## Motivation

Members ask for "keywords with over 10k searches", but the explorer can only
bound *rank*. Estimated monthly volume is displayed, sortable via rank, and
indexed — just not filterable. This filter is also the prerequisite for the
MCP research service: the research search reuses the same predicate, and a
research result can link to an Explorer view with identical filters.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| UI | The Rank range card gains a **Rank \| Volume** pill toggle (same styling as the Movement metric toggle). Rank shows the existing Best / Worst inputs; Volume shows Min / Max inputs for estimated monthly searches |
| Switching metric | **Clears the other pair's values** (exactly what the Movement toggle does), so a number is never silently reinterpreted on the other scale |
| Data model | **Separate fields** `volMin` / `volMax` on `ExplorerFilters`; `rankMin` / `rankMax` untouched. The toggle is presentational only (sidebar state), not a stored field. Old saved views and bookmarks parse unchanged |
| URL params | `vol_min` / `vol_max` (mirrors `rank_min` / `rank_max`) |
| Bounds | Inclusive, both optional; integers ≥ 0 via `parseNonNegativeInt`; min > max → 0 rows (same as rank) |
| NULL semantics | An active bound **excludes** keywords without a volume estimate (NULL only when no calibration fit existed at refresh). Helper text says so |
| Both pairs present in a URL | Both apply (AND). The sidebar opens on the Volume tab when either volume bound is set; via the UI only one pair can ever be set because switching clears the other |
| Sort | **No new sort.** Volume is monotone in rank through the calibration fit, so "highest volume" is exactly "best rank" |
| Counts | Any volume bound falls through to the live count (same guard pattern as reviews) |
| Covering path | Excluded — the 0046 covering index does not INCLUDE volume, so a volume bound routes to the classic paths (`kcs_est_vol_idx` or the rank/leaf indexes with a heap filter) |
| Rank sorts + volume bound | **Volume-ordered walk, per direction** (review findings, 2026-09-18). The rank walk is instant when the band sits where the walk starts and catastrophic when it must first skip every row outside the band. So `rank` (and the watchlist-only `added_*` fallbacks) with a **max** bound orders by `estimated_monthly_volume_current DESC NULLS LAST, current_rank ASC`; `rank_desc` with a **min** bound above 0 orders by `estimated_monthly_volume_current ASC NULLS FIRST, current_rank DESC` — the exact mirror of `kcs_est_vol_idx`, which is `DESC NULLS LAST` (NULLS placement follows the index, not SQL defaults). The other bound in each direction, and a no-op `vol_min=0`, keep the plain rank walk. The volume walk is taken only when the volume bound is the sole rank-correlated predicate: a rank-metric Movement jump or a rank bound is an index condition on the rank index but only a heap filter on the volume index, so those shapes keep the rank walk, bounded by the user's own rank predicates (a volume-metric jump bounds the volume index instead, so it narrows the volume walk and does not gate it). Same visible order either way: volume is monotone non-increasing in rank within a snapshot (one fit per refresh; 0 inversions over 2.68M rows verified on prod) and rank breaks equal-volume ties |
| Parser hardening | `parsePositiveInt` / `parseNonNegativeInt` accept safe integers only and reject anything above the column ceiling (int4 for rank / reviews / custom-jump thresholds, smallint for word counts, bigint for volume) — an over-range bound used to raise 22003 in the query and 500 the page |

## Part 1 — Types + parsing (`lib/explorer/types.ts`, `parseFilters.ts`)

- `ExplorerFilters` gains `volMin: number | null` and `volMax: number | null`,
  both `null` in `EXPLORER_DEFAULTS`.
- `parseExplorerFilters` reads `vol_min` / `vol_max` with the existing
  `parseNonNegativeInt`. Garbage → `null` silently (never-500 contract).

## Part 2 — Query predicate (`lib/explorer/buildQuery.ts`)

Two conditional pushes in `rangeBoundPredicates` (right after the rank
bounds, so they reach both query paths and both rows + count SQL):

```sql
kcs.estimated_monthly_volume_current >= $min   -- when volMin !== null
kcs.estimated_monthly_volume_current <= $max   -- when volMax !== null
```

`categoryPathIsCovered` additionally requires `volMin === null && volMax === null`.

`rankSortUsesVolumeWalk(filters)` is true for `rank` / `added_*` with a max
bound and for `rank_desc` with a min bound above 0, and only when no
rank-metric jump and no rank bound is active; `buildOrderBy` / `buildOuterOrderBy` then emit
the volume-first ORDER BY on the legacy path and on both levels of the q
path. Every other combination, and every other sort, keeps its existing
ORDER BY. The counts carry no ORDER BY and are unaffected; the covered path
is unreachable with a volume bound. The Drizzle schema now declares
`kcs_est_vol_idx` as `DESC NULLS LAST` to match migrations 0027/0041, since
the rewrite depends on that physical direction.

## Part 3 — Count guards (`lib/explorer/queryTotals.ts`)

`canUseDefaultTotal`, `canUseCategoryFacet`, `canUseLeafCategoryFacet` each
gain `&& f.volMin === null && f.volMax === null`.

## Part 4 — Sidebar (`app/(app)/explorer/FilterSidebar.tsx`, `page.tsx`)

- Pending state gains `rangeMetric: 'rank' | 'volume'`, `volMin`, `volMax`
  (numeric strings). `filtersToPending` derives `rangeMetric` = `'volume'`
  when either volume bound is set, else `'rank'`.
- The card label follows the metric: "Rank range (1 = best)" vs "Search
  volume range (est. monthly)". Toggle buttons carry `aria-pressed`.
- Rank → Volume clears `rankBest`/`rankWorst`; Volume → Rank clears
  `volMin`/`volMax`.
- Volume helper text: *"Estimated monthly searches at the current week.
  Excludes keywords without an estimate."*
- `pendingToParams` emits `vol_min` / `vol_max` when set. The dirty check
  ignores `rangeMetric` (it never changes the URL).
- `filtersToPending` / `pendingToParams` are exported for unit tests.
- `page.tsx`'s `filtersAreCustomized` adds both fields.

## Part 5 — Saved views + export (`lib/savedViews/validation.ts`)

`normalizeFiltersBlob` reads `volMin` / `volMax` with the typeof-number
guard; `filtersToSearchParams` emits `vol_min` / `vol_max`. Legacy blobs
parse to `null`. The CSV export route and `filtersToQueryString` inherit the
fields automatically (they round-trip through the same serializer).

## Part 6 — Performance verification (pre-ship, prod, read-only)

`EXPLAIN (ANALYZE, BUFFERS)` with real literals on prod (read-only, 60 s
statement cap, 2026-09-12 snapshot of 2,683,942 rows), using the SQL the
builder emits:

1. `vol_min=10000`, best-rank sort — plain rank walk, 2 ms;
2. `vol_min=10000` + `reviews_max=500` + one leaf path — leaf-index walk + filter, 318 ms cold / 2 ms warm;
3. `vol_min=10000` + Δ-volume improvement sort (4w) — partial vol-delta index walk, 171 ms cold / 1 ms warm;
4. `vol_min=10000` + `vol_max=50000`, best-rank sort — volume walk + incremental sort, 204 ms (2.2 s cold on the rank walk, which skipped 14.6k rows first);
5. `vol_max=10000`, best-rank sort — volume walk, 242 ms (**12.3 s** on the rank walk: 102k rows skipped);
6. `vol_min=100000`, worst-rank sort — volume walk, 2 ms (**54.6 s** on the rank walk: 2.68M rows skipped, past the function cap);
7. `vol_max=10000`, worst-rank sort — plain rank walk, 0.7 ms (an earlier draft of the rewrite sent this through a `NULLS LAST` order the index cannot serve: 24 s seq-scan + sort; the per-direction rule keeps it on the rank walk);
8. **Residual:** a worst-rank sort whose min lands at or below the tail floor (`vol_min` 1–~500; the snapshot minimum is 424) starts inside the tail's largest equal-volume groups — 70–96k keywords each, which are the SFR report's tied rank values — and the incremental sort reads one group before emitting page 1: 8.6–10.2 s cold, 0.5–0.7 s warm. Bounded by the largest group, unlike the rank walk's 55 s. `vol_min=0` (a no-op) is special-cased back to the rank walk. Follow-up if it ever matters: a composite `(current_week_end_date, estimated_monthly_volume_current DESC NULLS LAST, current_rank)` index plus its stage twin makes every case a pure index walk — DDL, owner-gated, deferred;
9. `vol_max=10000` + Movement preset 500k→100k (rank), best-rank sort — the gate keeps the rank walk, bounded at the preset's 100k window: 13.4 s cold / 0.65 s warm for an empty result (volume 10,000 sits at rank ~102k, so the band is empty); the volume walk would have read ~2.6M rows. Same cost class as today's jump presets with any unselective extra filter. `vol_min=10000` + the same preset: 2.5 s cold / 146 ms warm;
10. Both pairs via URL (`rank_max=1000` + `vol_max=10000`, empty band) — rank walk bounded at 1,000 rows, 2 ms. URL-only: the sidebar clears the other pair on switch. With both pairs the gated rank walk costs roughly the rows between the rank bound and where the volume bound sits, so a wide rank bound next to a contradictory volume bound can still walk a large stretch (e.g. `rank_desc` + `rank_min=5` + `vol_min=100000` is the 55 s shape). Accepted as URL-only;
11. Monotonicity premise: `lag()` over the whole snapshot ordered by rank — 0 inversions, 0 NULL volumes. The refresh builds the snapshot in a stage table and swaps by rename, so readers never see two fits at once. Follow-up worth adding to the refresh later: a post-INSERT inversion check that logs if a future piecewise fit ever breaks the premise.
12. Volume-metric Movement jump + volume bound (not gated, since the jump's current-side condition is on the volume column): `v5k_to_15k` + `vol_max=20000` under best-rank sort is a two-sided range on `kcs_est_vol_idx`, 1.9 s cold / 18 ms warm; `v30k_to_100k` + `vol_min=1000` under worst-rank sort, 2.2 s cold / 7 ms warm.

Acceptance: no seq-scan + full sort on any probed shape; warm latency in
line with existing filtered queries. Met.

## Testing

- `parseFilters.test.ts`: both params parsed; `0` accepted; negative /
  non-numeric → null; defaults null; the every-param test passes both
  params; safe-integer and per-column ceilings rejected.
- `buildQuery.test.ts`: predicates present in rows SQL **and** count SQL on
  both paths when set; absent by default; `volMax: 0` is an active bound;
  `categoryPathIsCovered` false with either bound; the per-direction
  volume-ordered ORDER BY (legacy + both q-path levels), the plain rank walk
  for the other bound and for `vol_min=0`, and the `rankSortUsesVolumeWalk`
  truth table including the rank-metric-jump / rank-bound gate and the
  volume-metric-jump pass-through.
- `queryTotals.test.ts`: all three guards false with either bound.
- `lib/savedViews/validation.test.ts`: normalizeFilters round-trip; blob
  read; legacy blob → null; serializer emits the params.
- `lib/explorer/export/query.test.ts`: round-trip includes a volume bound.
- `FilterSidebar.test.tsx` (new): pending derivation, URL emission, and the
  clear-on-toggle behavior via a rendered sidebar with a mocked router.

## Non-goals

- No stored "range metric" field; no volume sort; no watchlist filtering.
- No changes to the CSV columns, digest, worker, refresh, or DDL.

## Ship checklist (owner-gated)

1. Typecheck + full suite green; independent code-review pass.
2. Prod EXPLAIN probes (Part 6) reviewed.
3. Owner tries the toggle on prod after deploy.
4. Push gate: `scripts/checkActiveJobs.ts` first, then push on explicit authorization.
