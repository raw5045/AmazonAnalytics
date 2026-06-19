# Explorer Filter Performance + Loading Overlay — Design

**Date:** 2026-06-19
**Status:** Draft for review
**Area:** `/explorer` keyword filter — `lib/explorer/*`, `app/(app)/explorer/*`

---

## 1. Problem

Two user-reported symptoms on `/explorer`:

1. **"Search term contains" (`q`) is very slow** — typing a word into the substring filter can hang for many seconds.
2. **"Next" page is very slow**, and gets worse the deeper you page.

### Root cause (measured, not theorized)

`EXPLAIN (ANALYZE, BUFFERS)` against the live DB (snapshot week `2026-06-13`, `keyword_current_summary` = 3,846,849 rows). Numbers below are **cold-cache** (first hit) from `scripts/diagExplorerFilterPerf.ts`; the warm `EXPLAIN` re-runs were 50–100× faster — i.e. the cost is **cold random I/O from Neon storage**, the same pathology we fixed on the detail page.

| word | matches | live count (cold) | **page 1 (cold)** | **page 21 / OFFSET 2000 (cold)** |
|---|---|---|---|---|
| `hair` | 10,001+ | 6.4 s | **24.7 s** | **151 s** |
| `protein` | 6,224 | 0.2 s | 12.2 s | 93 s |
| `men` | 10,001+ | **3.2 s** | 0.07 s | 0.3 s |
| `oil` | 10,001+ | 0.4 s | 0.3 s | 2.6 s |
| no-`q` baseline | — | 0 (precomputed) | 0.06 s | 0.09 s |

Three mechanisms, all triggered only when `q` is set:

1. **Rank-ordered nested-loop probe.** The rows query plan walks `keyword_current_summary` in `current_rank` order via `…_current_week_end_date_current_idx`, and for **every** row probes `search_terms` by PK to test `search_term_normalized LIKE '%q%'`. When the word is sparse among top ranks (`hair`), it inspects **12,880 rows to fill page 1** and **150,746 rows to fill page 21** — each a random PK probe into cold storage.
2. **`OFFSET` amplification.** Deeper pages walk proportionally more rows (page 21 ≈ 12× page 1). This is the "Next gets slower" symptom.
3. **Per-page live count.** Setting `q` disables every count short-circuit (`canUseDefaultTotal` / `canUseCategoryFacet` / `canUseLeafCategoryFacet` all require `q === null`), so a capped `COUNT(*)` (LIMIT 10001) over the trigram+join runs **on every page** even though the total is identical across pages. For broad substrings (`men`, 3.2 s) this is the dominant cost by itself.

The no-`q` path is already fast (60–91 ms) via the rank index + precomputed count short-circuits and is **not** touched by this work.

### Secondary issue (UX)

During a slow filter, `FilterSidebar.apply()` runs `startTransition(() => router.replace(...))`, which keeps the **old** results on screen with only a small "Applying…" label. There is no obvious "the site is working" signal, so a multi-second query reads as a frozen page. The route-level `loading.tsx` skeleton fires on hard/cold navigations, not on these in-place `useTransition` filter/sort/pagination updates.

---

## 2. Goals / Non-goals

**Goals**
- Make `q`-filtered queries fast and **flat across pages** (page N ≈ page 1), for **every** sort option the explorer exposes.
- Eliminate the per-page live-count recomputation for the `q` path.
- Add an obvious centered **loading overlay** during in-place transitions — for **any** filter Apply (not only `q`), plus sort and pagination.

**Non-goals (explicitly deferred — see §8)**
- **Next-page prefetch / result caching.** Natural fast-follow once pages are cheap; separate change.
- **Denormalization** (searchable text + sort keys onto `kcs`) for sub-second *cold* first-search. Revisit only if cold numbers still bother us after this ships.

---

## 3. Design — core query rewrite

### 3.1 Trigram-first via a `MATERIALIZED` CTE (the `q` path only)

Replace the "walk rank-order and probe each row" plan with "grab the matches first, then sort." When `filters.q` is set, `buildExplorerQuery` emits:

```sql
WITH matches AS MATERIALIZED (
  SELECT id, search_term_raw
  FROM search_terms
  WHERE search_term_normalized LIKE $q          -- '%word%', lowercased
)
SELECT
  kcs.search_term_id,
  m.search_term_raw,
  kcs.current_rank,
  kcs.<prior_rank col> AS prior_rank,
  kcs.<improvement col> AS improvement,
  …all existing kcs SELECT-list columns…,
  count(*) OVER () AS total_matches             -- exact total, same pass
FROM keyword_current_summary kcs
JOIN matches m ON m.id = kcs.search_term_id
WHERE kcs.current_week_end_date = $week::date
  -- plus any other active predicates, unchanged (rank min/max, jump,
  -- category, leaf categories, severities, title-gap) — all on kcs
ORDER BY <existing buildOrderBy output>
LIMIT $perPage OFFSET $offset
```

Why this works:

- **`MATERIALIZED`** forces Postgres to evaluate the trigram CTE first (bounded by *match count*, ~35k for `hair`), preventing it from choosing the rank-walk. The join back to `kcs` is a PK lookup per match; the sort is an in-memory sort of the matched set.
- **Cost is bounded by match count, not by `OFFSET`** → page 21 costs the same as page 1. The 151 s / 24.7 s cases collapse to the match-set read (~6 s cold worst-case for a very common word, sub-second warm).
- **All sort options are covered for free.** Every column `buildOrderBy` can target — `current_rank`, `improvement_{window}`, `keyword_title_match_count[_loose]_current`, `avg_price_cents`, `avg_reviews` — lives on `kcs`, which is already joined. We sort the small matched set; **no new per-column indexes are required.** (`added_asc/desc` are watchlist-only and already fall back to rank.)
- **Composes with every other filter** — the other predicates stay in the `WHERE` on `kcs`, so `q` + rank range + severity + category + title-gap all still combine.
- The CTE carries `search_term_raw`, so no second `search_terms` lookup is needed in the outer SELECT.

### 3.2 The total comes free from the same pass

`ORDER BY … LIMIT` already forces the executor to read the **entire** matched set before it can return the top 100, so adding `count(*) OVER ()` (which also needs the full set) costs nothing extra. Every returned row carries the same `total_matches`; the runner reads it from row 0.

This means **the `q` path no longer runs a separate count query at all** — `runExplorerQuery` returns rows + total from one query. (The window count is *not* used on the no-`q` path, where the rank index streams ordered rows and `LIMIT` stops early — that path keeps its existing meta/facet short-circuits.)

**Edge case — empty page:** if `OFFSET` lands past the end (0 rows returned, e.g. a tampered URL), there is no row to carry `total_matches`. Handle by issuing one lightweight fallback count (the same CTE wrapped in `SELECT count(*)`) only when the `q` rows result is empty. Normal in-range pages never hit this.

### 3.3 Count semantics + safety guard

- The window count is **exact** (no 10,001 cap), which is a small UX win over today's "10,000+".
- **Pagination cap stays** at the existing `COUNT_CAP` (10,000) for footer/jump parity — i.e. the footer may still display "10,000+" and cap page jumps, even though we know the exact total internally. (Keeps current UX; avoids advertising 6-figure page counts.)
- **Worst-case guard:** a 3-char common substring (e.g. `pro`) can match 100k+ terms; materializing + sorting all of them is bounded but not free cold. Add a tunable cap `Q_MATCH_MATERIALIZE_CAP` (recommend **50,000**) as `LIMIT` inside the `matches` CTE. Below the cap (virtually all real searches, incl. `hair`@35k) behavior is exact and fully rank-correct. Above it, we read the first 50k trigram matches and label the total "50,000+" — a documented degradation that bounds worst-case latency and protects the DB. This is strictly better than today's unbounded walk. **Open for reviewer input;** default is 50k.

### 3.4 `runExplorerQuery` changes

- Branch on `filters.q`:
  - **`q` set:** run the single CTE query; `rows` + `total` from its result; `countMs` folds into `rowsMs` (one round-trip); `countSource = 'live'` stays accurate (it *is* live, just free).
  - **`q` null:** unchanged — existing rows query + meta/facet count short-circuits.
- `timings` / `PerfStrip`: keep the shape; for the `q` path `countMs` reports 0 (no separate count) and a note clarifies the total is from the rows pass. Minor copy tweak only.

---

## 4. Design — loading overlay (the UI fix)

**Independent of §3.** The overlay is driven by the navigation transition, not the query — so it appears on **every** filter Apply (category, rank, severity, leaf, jump, title-gap, `q`, …), plus sort and pagination, regardless of how fast or slow the resulting query is. A user who applies *any* filter gets the immediate "working on it" signal.

### 4.1 Component

New client component `app/(app)/explorer/LoadingOverlay.tsx`: a fixed, full-viewport, semi-transparent backdrop centering a spinner **ring** (a full faint circle with one blue arc rotating around it) with **"Loading"** in the middle.

```tsx
'use client';
export function LoadingOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-white/60 backdrop-blur-[1px]"
      role="status" aria-live="polite" aria-busy="true"
    >
      <div className="relative h-16 w-16">
        <div className="absolute inset-0 rounded-full border-4 border-gray-200" />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-600 animate-spin" />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700">
          Loading
        </span>
      </div>
    </div>
  );
}
```

Uses Tailwind's built-in `animate-spin` (no new keyframes). `role="status"` + `aria-busy` for accessibility.

### 4.2 Driving it from the existing transitions

The three controls that trigger a server recompute each already hold their own `useTransition`:
- `FilterSidebar` — Apply / Reset (`isPending`)
- `Pagination` — Prev / Next / Jump (`isPending`)
- `SortableHeader` — column-click sort (`isPending`)

Each simply renders the shared `<LoadingOverlay show={isPending} />` from its existing local `isPending` — **no new context, provider, or layout change.** Only one is active at a time, so the single overlay appears once. Existing inline labels ("Applying…", "Loading…") can stay or be dropped; the overlay is now the primary signal.

This keeps the change small and robust: because `SortableHeader` is shared with `/watchlist`, that page transparently gets the same overlay on sort with **no extra wiring**. Complementary to `loading.tsx` (which handles hard/cold loads); the overlay handles in-place transitions, so there's never a double indicator.

(If we later want a single hoisted pending signal — e.g. to cover navigations from elsewhere — a tiny client context/provider in the explorer layout is the upgrade path. Not needed for this fix.)

> **Next 16 note (per AGENTS.md):** `useTransition` is React, not Next-version-sensitive. Before implementing, check `node_modules/next/dist/docs/` for whether Next 16 exposes a first-class router-pending hook (e.g. `useLinkStatus`) that's cleaner than the shared-context approach; if so, prefer it. The context approach is the robust fallback and the spec's baseline.

---

## 5. Files

**Modify**
- `lib/explorer/buildQuery.ts` — emit the `MATERIALIZED` CTE + `count(*) OVER ()` form when `q` is set; keep the existing form otherwise. Add `Q_MATCH_MATERIALIZE_CAP`.
- `lib/explorer/runQuery.ts` — `q`-path returns rows + total from one query; skip the separate count; empty-page fallback count; timings tweak.
- `lib/explorer/buildQuery.test.ts` — assertions for the new `q` SQL shape (CTE present, window count present, ORDER BY per sort, other filters compose, cap applied).
- `app/(app)/explorer/FilterSidebar.tsx`, `Pagination.tsx`, `SortableHeader.tsx` — render `<LoadingOverlay show={isPending} />` from their existing local `useTransition`.
- `app/(app)/explorer/PerfStrip.tsx` — minor copy for the `q` count note.

**Create**
- `app/(app)/explorer/LoadingOverlay.tsx`

**Unchanged**
- No-`q` query path, meta/facet short-circuits, `parseFilters.ts`, schema/migrations (no DDL).

---

## 6. Testing

- **Unit (`buildQuery.test.ts`, TDD):** for representative filter sets with `q` set — the SQL contains `WITH matches AS MATERIALIZED`, the trigram `LIKE` param, `count(*) OVER ()`, the correct `ORDER BY` for each sort key, and the other predicates in the outer `WHERE`; the cap `LIMIT` is present in the CTE; arg ordering is correct (CTE arg, week, filter args, limit/offset). Confirm the no-`q` path SQL is byte-identical to today.
- **Behavioral (runner):** with `q`, total comes from the rows pass and no second count query is issued; empty-page fallback returns total without crashing.
- **Perf verification (manual, `scripts/diagExplorerFilterPerf.ts` re-run):** confirm `hair` page 1 ≈ page 21 (flat), both ≫ faster than the 24.7 s / 151 s baseline; warm sub-second.
- **UI (manual):** Apply / Next / column-sort each show the centered "Loading" overlay until results arrive; overlay disappears on completion; no double-spinner with `loading.tsx` on cold load.

---

## 7. Performance expectations

| scenario | today (cold) | after (cold) | after (warm) |
|---|---|---|---|
| `hair` page 1 | 24.7 s | ~6 s | <1 s |
| `hair` page 21 | 151 s | ~6 s (flat) | <1 s |
| broad `q` count (per page) | 3–6 s every page | folded into rows, once | ~0 |
| no-`q` browse | 0.06 s | 0.06 s (unchanged) | 0.06 s |

Flat-across-pages + free count is the core win; warm pages are sub-second, which is what prefetch (§8) then makes feel instant.

---

## 8. Future work (out of scope here)

1. **Next-page prefetch / caching** — once pages are cheap and warm, prefetch the next page on idle so "Next" feels instant; also benefits no-`q` browsing. Needs Next 16 caching care (stale totals, per-user watchlist stars).
2. **Denormalize** searchable text + sort keys onto `kcs` (+ trigram GIN) to push cold first-search from ~6 s toward ~1 s. Costs a migration + weekly-refresh upkeep + a GIN index rebuilt each stage-and-swap — only worth it if cold still bothers users.

---

## 9. Risks / rollback

- **Planner regression for unusual filter mixes** — mitigated by `buildQuery.test.ts` coverage across the filter matrix and a live `EXPLAIN` re-run before shipping. Pure code change (no DDL), so rollback is a revert.
- **Pathological broad substring latency** — bounded by `Q_MATCH_MATERIALIZE_CAP`.
- **Overlay flashing on fast warm transitions** — acceptable (sub-100 ms flash); if annoying, add a short show-delay in the plan.
