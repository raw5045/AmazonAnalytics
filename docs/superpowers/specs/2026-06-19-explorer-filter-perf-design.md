# Explorer Filter Performance + Loading Overlay — Design (v2)

**Date:** 2026-06-19 (v2 supersedes the v1 trigram-CTE design after live measurement)
**Status:** Approved — implementing
**Area:** `/explorer` keyword filter — `lib/explorer/*`, `app/(app)/explorer/*`, `inngest/functions/refreshSummary.ts`, `db/`

---

## 0. Why v2 (what measurement changed)

v1 proposed a trigram-first `MATERIALIZED` CTE over `search_terms` for the substring (`q`) filter. Built it, then measured against the live DB and found three things v1's estimates missed:

1. **"contains" was a *substring* match** — `hair` matched `chair`, `mohair`, `hairbrush`. That's ~45.6k current keywords for `hair`, most of them noise the user doesn't want. The *behavior* was wrong, not just slow.
2. **The `search_terms` CTE drags in historical dead-weight.** `search_terms` holds all-time terms; the current week is a subset. For `hair` the CTE materialized ~50k+ all-time matches and probed `kcs` for every one (~36k of them not even current) → page 1 ~48 s cold, *worse* than the old rank-walk.
3. **The 50k cap made broad-word results incorrect** — it capped an *arbitrary* (non-rank-ordered) slice of trigram matches, so `hair` showed 13,539 of a real ~29k and could omit a genuinely top-ranked keyword.

**Decisions (with the user):**
- **Whole-word matching is the default** (correct + intuitive). Measured reduction: `hair` 45.6k→29k, `oil` 25k→14.7k, `men` 305k→65.5k.
- **Denormalize the searchable text onto the current-week summary table** (`keyword_current_summary`, "kcs") so the search is single-table, current-only (no dead-weight, no cap), and uses one GIN trigram index. Refresh cost measured: **~24 s index build + a cheap join** (negligible, on the background worker, swap stays instant).
- **Add a Whole-word ⇄ Broad toggle.** Broad = the old substring behavior, now *correct* (current-only) but opt-in, "(slower)", and timeout-guarded.

The loading overlay (v1 §4) is already implemented and unchanged.

---

## 1. Root cause (measured)

`EXPLAIN (ANALYZE, BUFFERS)` against live Neon (week `2026-06-13`, kcs = 3,846,849 rows). The slowness is exact-ranking over a large match set read from cold Neon storage: to return "top-100 by rank," every matching row must be read. Narrow searches (a phrase, or `collagen` ≈ 2.3k) are tiny → fast. Broad bare words are inherently seconds because there are genuinely tens of thousands of them. The fix minimizes *how many* rows are read (current-only via denormalization, whole-word over substring) and *how fast* (single-table sequential reads, one index), and makes any unavoidable wait correct + visible (overlay) + flat across pages (window count, no OFFSET walk).

---

## 2. Goals / Non-goals

**Goals**
- **Whole-word `q` matching by default**, single-table on kcs, fast for specific searches, correct + flat across pages, for every sort option.
- **Broad (substring) mode as an opt-in toggle** — correct (current-only), labeled "(slower)", guarded by a per-query timeout.
- **Denormalize** `search_term_normalized` + a GIN trigram index onto kcs, maintained in the weekly refresh (~½ min) + a one-time backfill.
- Pagination total from the same pass (`count(*) OVER ()`), no separate per-page count.
- Centered **loading overlay** on any filter/sort/pagination transition (already shipped).

**Non-goals (deferred)**
- Next-page prefetch / result caching (fast-follow once pages are cheap).
- Full-text/stemming search (`hairs`→`hair`). Whole-word regex is exact-token; revisit only if stemming is wanted.

---

## 3. Design

### 3.1 Denormalize searchable text onto kcs

- **Migration:** add `search_term_normalized varchar(512)` (nullable) to `keyword_current_summary` **and** `keyword_current_summary_stage`, plus a GIN trigram index on each:
  `CREATE INDEX … ON … USING gin (search_term_normalized gin_trgm_ops)`.
  Same index type already proven on `search_terms` (migration 0002). One index serves **both** word-regex (`~`) and substring (`LIKE`).
- **Refresh upkeep** (`refreshSummary.ts`): the stage INSERT (the 3.85M-row build at lines ~204-318) gains one `LEFT JOIN search_terms st ON st.id = l.search_term_id` and selects `st.search_term_normalized`. After the INSERT + `ANALYZE`, **build the GIN index on the stage table** before the swap (~24 s measured). The swap stays a metadata-only `RENAME`; readers never see a half-built index. (Keep the GIN out of the permanent stage indexes so the bulk INSERT isn't slowed by incremental GIN maintenance — drop-before / build-after, or build-after on a freshly truncated stage.)
- **Backfill** (one-time, `scripts/backfillKcsNormalized.ts`): `UPDATE keyword_current_summary kcs SET search_term_normalized = st.search_term_normalized FROM search_terms st WHERE st.id = kcs.search_term_id` (single set-based update, ~minutes), then `CREATE INDEX … USING gin (…)` on the live table (~24 s). Idempotent, read-mostly on `search_terms`. Requires explicit user go-ahead (touches the live table).

Storage: ~200 MB GIN + ~230 MB text on kcs. Modest.

### 3.2 The query — single-table whole-word / broad match on kcs

When `q` is set, the q-path matches on the denormalized kcs column directly (no `search_terms` CTE). `search_term_raw` (display only) is joined for the final page rows via a subquery so it's read for ~100 rows, not the whole match set:

```sql
SELECT k.search_term_id, st.search_term_raw, k.current_rank, k.prior_rank,
       k.improvement, …all display cols…, k.total
FROM (
  SELECT kcs.search_term_id, kcs.current_rank,
         kcs.<prior_rank col> AS prior_rank, kcs.<improvement col> AS improvement,
         …all kcs display cols…,
         (count(*) OVER ())::int AS total
  FROM keyword_current_summary kcs
  WHERE kcs.current_week_end_date = $week::date
    AND kcs.search_term_normalized ~ $pattern        -- whole word: '\m<q>\M'
    -- (broad mode: kcs.search_term_normalized LIKE $pattern, '%<q>%')
    -- + any other active filters (rank, jump, category, leaf, severity, title-gap)
  ORDER BY <sort>                                     -- every sort option, all kcs cols
  LIMIT $perPage OFFSET $offset
) k
JOIN search_terms st ON st.id = k.search_term_id
ORDER BY <sort>;                                      -- re-assert order across the join
```

- **Whole word:** `pattern = '\m' + escapeRegex(q) + '\M'` bound as a parameter; uses the kcs GIN via the `~` operator. Works for single words and phrases (bounded phrase match).
- **Broad:** `pattern = '%' + escapeLike(q) + '%'`; uses the same kcs GIN via `LIKE`.
- **Correctness:** kcs is current-week-only, so the match set *is* the true current match set — **no cap, no arbitrary subset.** `count(*) OVER ()` gives the exact total in the same pass (still display-capped at `COUNT_CAP` for the footer/pagination).
- **`escapeRegex` / `escapeLike`** sanitize user input so a term like `c++` or `50%` can't break or wildcard the query. Both are pure, unit-tested helpers.
- **Broad-mode timeout guard:** the runner sets `SET LOCAL statement_timeout = 30000` for broad queries; on timeout, return a typed "too broad" result the page renders as a friendly message (narrow it / use whole-word). Whole-word has no special timeout (it's bounded by the smaller match set).

The **no-`q` path is simplified, not rewritten**: it keeps its current shape (kcs + `search_terms` join for raw, rank index, existing count short-circuits). Only the q-path changes.

### 3.3 Match-mode parameter + UI toggle

- `parseFilters`: new `qMode: 'word' | 'broad'` (URL `qmode`, default `'word'`). Only meaningful when `q` is set.
- `FilterSidebar`: a small segmented control under "Search term contains": **Whole word** (default) / **Broad (slower)**. When Broad is selected, show a one-line note: "Broad match scans partial words too — may take longer for common words." Plumbs `qmode` into the Apply URL like the other filters.
- Saved views carry `qMode` (it's part of the filter set).

### 3.4 runQuery

- q-path: run the single query; total from the window count (reuse the v1 `queryTotals` helpers — `applyCountCap`, `extractWindowTotal`, empty-page fallback). For broad mode, wrap in the `statement_timeout` guard and map a timeout error to the typed "too broad" result.
- non-q path: unchanged (meta/facet short-circuits intact).

---

## 4. Loading overlay (already implemented — unchanged)

`app/(app)/explorer/LoadingOverlay.tsx`: a `fixed inset-0` dimmed backdrop centering a pure-CSS ring spinner (faint ring + rotating blue arc, "Loading" centered, `role="status"`). Rendered from the existing `isPending` in `FilterSidebar`, `Pagination`, and `SortableHeader`, so **every** filter Apply / sort / page change shows it (and `/watchlist` inherits it via `SortableHeader`). Complementary to `loading.tsx` (hard/cold loads). Shipped in commits `4044cc8` + `048cbf7`.

---

## 5. Files

**Migration / schema**
- `db/migrations/0037_kcs_search_term_normalized.sql` *(new)* — add column to kcs + stage; GIN trigram index on each.
- `db/schema/keywordCurrentSummary.ts` — add `searchTermNormalized`.

**Query**
- `lib/explorer/types.ts` — add `qMode` to `ExplorerFilters`; keep `countFromRows` on `BuiltExplorerQuery`; add a typed "broad too slow" result shape.
- `lib/explorer/parseFilters.ts` — parse `qmode` (default `word`).
- `lib/explorer/matchPattern.ts` *(new)* — `escapeRegex`, `escapeLike`, `wordPattern(q)`, `broadPattern(q)` (pure, unit-tested).
- `lib/explorer/buildQuery.ts` — rewrite the q-path to the single-table kcs subquery form (word vs broad predicate); keep the no-q path.
- `lib/explorer/runQuery.ts` — q-path single query + window total; broad-mode `statement_timeout` guard → typed timeout result.
- `lib/explorer/queryTotals.ts` — reused as-is.

**Refresh + backfill**
- `inngest/functions/refreshSummary.ts` — populate the column (join) + build the GIN on stage before swap.
- `scripts/backfillKcsNormalized.ts` *(new)* — one-time set-based populate + index build on the live table.

**UI**
- `app/(app)/explorer/FilterSidebar.tsx` — Whole-word/Broad toggle + note (already renders the overlay).
- `app/(app)/explorer/PerfStrip.tsx` — minor copy.

**Tests:** `matchPattern.test.ts`, `parseFilters.test.ts`, `buildQuery.test.ts` (q-path word + broad shapes, escaping, all sorts compose, no-q unchanged), `queryTotals.test.ts` (reused).

---

## 6. Testing

- **Unit:** `escapeRegex`/`escapeLike`/`wordPattern`/`broadPattern` (metachars, phrases). `buildQuery` q-path emits the kcs subquery with `~ '\m…\M'` (word) or `LIKE '%…%'` (broad), the window count, the outer `search_terms` raw-join, the correct ORDER BY per sort, and other filters composed; no-q path byte-stable. `parseFilters` defaults `qmode=word`, rejects junk.
- **Behavioral:** total from the rows pass; broad-mode timeout maps to the typed "too broad" result; empty-page fallback.
- **Perf verification (script, live DB):** `collagen`/`vitamin` sub-second; `hair` whole-word reads ~29k current → seconds, flat page 1 ≈ page 21; broad `men` hits the timeout guard gracefully.
- **Refresh:** integration check that a refresh populates the column + index and the swap succeeds; index present on the live table post-swap.
- **Manual UI:** toggle shows/works; overlay on every Apply; broad note appears; "too broad" message renders.

---

## 7. Performance expectations

| scenario | before | after |
|---|---|---|
| specific search (`collagen`, phrase) | ~fast | sub-second, correct |
| `hair` whole-word, page 1 | (substring) 24.7 s cold | ~5–10 s cold, sub-second warm, **flat** |
| `hair` whole-word, page 21 | 151 s cold | ≈ page 1 (flat) |
| `men` broad | n/a | graceful timeout message (~30 s cap) |
| `chair`/`mohair` under `hair` | matched (wrong) | **excluded** (whole word) |
| weekly refresh | N min | N + ~½ min (background, swap instant) |

---

## 8. Future work
1. **Prefetch / cache** the next page once pages are cheap (also helps no-`q` browsing).
2. **Stemming** (FTS) if `hair`↔`hairs` matching is wanted — a tsvector GIN variant.

---

## 9. Risks / rollback
- **DDL on Neon** (migration) and the **one-time backfill** touch the live DB — both gated on explicit user go-ahead; the migration is additive (nullable column + index), and the q-path falls back to the current behavior if the column/index is absent (graceful), so rollback is a revert.
- **Regex/LIKE injection or breakage** — mitigated by `escapeRegex`/`escapeLike` with unit tests.
- **Broad runaway** — bounded by the per-query `statement_timeout`.
- **Refresh slowdown** — measured ~½ min, off the hot path; the GIN is built on stage pre-swap so readers are never affected.
